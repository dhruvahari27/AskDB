import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { MemorySaver } from '@langchain/langgraph';
import { AgentRunner, MemoryGlossary, buildSimulateUserPrompt, cachedCatalogProvider, extractJson, type LlmProvider } from '@askdb/agent';
import { sameResult, type Cell, type Clarification } from '@askdb/shared';
import { guardSql, runReadOnly, type RunOptions } from '@askdb/sql-guard';
import { policyFromCatalog } from '@askdb/agent';
import { expandGold, type EvalCase } from './dataset';
import type { CaseResult, Mode } from './metrics';

/** The same approved definitions the app seeds, for runs that want "production defaults". */
export const DEFAULT_TERMS = [
  { term: 'last month', definition: 'the previous full calendar month before the as-of date (the as-of date is the latest order date in the data)' },
  { term: 'last quarter', definition: 'the previous full calendar quarter before the as-of date' },
  { term: 'last year', definition: 'the previous full calendar year before the as-of date' },
  { term: 'this year', definition: 'the current calendar year from January 1 up to and including the as-of date' },
].map((t) => ({ ...t, status: 'approved' as const, source: 'default', sqlSnippet: null }));

export interface HarnessOptions {
  llm: LlmProvider;
  warehouse: pg.Pool;
  limits: RunOptions;
  useDefaultGlossary: boolean;
  maxTurns?: number;
}

export function previewText(o: Clarification['options'][number]): string | undefined {
  if (!o.preview) return undefined;
  return o.preview.rows.slice(0, 3).map((r) => r.map((c) => String(c)).join(' | ')).join(' ; ');
}

export class Harness {
  private catalog;
  constructor(private o: HarnessOptions) {
    this.catalog = cachedCatalogProvider(o.warehouse);
  }

  async asOf(): Promise<string> {
    return (await this.catalog()).asOf;
  }

  /** Run the gold SQL through the same guard and executor the product uses, so gold and prediction are judged alike. */
  async goldRows(c: EvalCase): Promise<Cell[][]> {
    const cat = await this.catalog();
    const sql = expandGold(c.goldSql, cat.asOf);
    const g = await guardSql(sql, policyFromCatalog(cat));
    if (!g.ok) throw new Error(`Gold SQL for ${c.id} is rejected by the guard: ${g.message}`);
    return (await runReadOnly(this.o.warehouse, g.sql, this.o.limits)).rows;
  }

  async runCase(c: EvalCase, mode: Mode, gold: Cell[][]): Promise<CaseResult> {
    const glossary = new MemoryGlossary(this.o.useDefaultGlossary ? DEFAULT_TERMS : []);
    // A fresh runner (and checkpointer) per case keeps cases independent; explanations are skipped to save tokens.
    const runner = new AgentRunner({
      llm: this.o.llm,
      warehouse: this.o.warehouse,
      catalog: this.catalog,
      glossary,
      checkpointer: new MemorySaver(),
      limits: this.o.limits,
      explain: false,
    });
    const runId = randomUUID();
    const maxTurns = this.o.maxTurns ?? 3;
    const started = Date.now();
    let tokens = 0;
    let llmCalls = 0;
    let turns = 1;
    let asked = false;
    const base = { caseId: c.id, mode, question: c.question, isAmbiguous: c.isAmbiguous, ambiguityType: c.ambiguityType, split: c.split } as const;
    const add = (u: { inputTokens: number; outputTokens: number; llmCalls: number }) => {
      tokens += u.inputTokens + u.outputTokens;
      llmCalls += u.llmCalls;
    };

    try {
      let outcome = await runner.start({ runId, question: c.question, mode });
      add(outcome.usage);
      while (outcome.status === 'awaiting_clarification' && turns <= maxTurns) {
        asked = true;
        turns++;
        const reply = await this.simulateUser(c, outcome.clarification);
        outcome = await runner.resume(runId, reply);
        add(outcome.usage);
      }
      const ms = Date.now() - started;
      if (outcome.status !== 'complete') {
        const error = outcome.status === 'failed' ? outcome.error : 'Still asking after the maximum number of turns';
        return { ...base, correct: false, asked, turns, ms, tokens, llmCalls, error };
      }
      return { ...base, correct: sameResult(outcome.answer.result.rows, gold), asked, turns, ms, tokens, llmCalls, predictedSql: outcome.answer.sql };
    } catch (e) {
      return { ...base, correct: false, asked, turns, ms: Date.now() - started, tokens, llmCalls, error: (e as Error).message.slice(0, 300) };
    } finally {
      runner.forget(runId);
    }
  }

  /** An LLM plays the person asking and answers from the case's stored intent. Its tokens are not charged to the system under test. */
  private async simulateUser(c: EvalCase, clar: Clarification): Promise<{ optionId?: string; freeText?: string }> {
    const prompt = buildSimulateUserPrompt({
      question: c.question,
      trueIntent: c.trueIntent ?? c.question,
      clarifyingQuestion: clar.question,
      options: clar.options.map((o) => ({ id: o.id, meaning: o.meaning, preview: previewText(o) })),
    });
    const res = await this.o.llm.complete({ task: 'simulate_user', system: prompt.system, user: prompt.user, json: true, temperature: 0 });
    try {
      const j = extractJson(res.text) as { optionId?: string; freeText?: string };
      if (j.optionId && clar.options.some((o) => o.id === j.optionId)) return { optionId: j.optionId };
      if (j.freeText && j.freeText.trim().length >= 2) return { freeText: j.freeText.trim().slice(0, 400) };
    } catch {
      /* fall through */
    }
    return { freeText: c.trueIntent ?? c.question };
  }
}
