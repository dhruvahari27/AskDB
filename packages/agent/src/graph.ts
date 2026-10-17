import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { Annotation, END, START, StateGraph, interrupt, isGraphInterrupt, type BaseCheckpointSaver } from '@langchain/langgraph';
import { z } from 'zod';
import {
  ClassifyResponseSchema,
  DraftResponseSchema,
  resultFingerprint,
  type AgentMode,
  type AnswerPayload,
  type Candidate,
  type Clarification,
  type ClarificationOption,
  type ColumnMeta,
  type RunEvent,
  type TabularResult,
} from '@askdb/shared';
import { QueryError, guardSql, runReadOnly, type RunOptions } from '@askdb/sql-guard';
import { policyFromCatalog, type CatalogProvider } from './catalog';
import type { GlossaryStore, GlossaryTerm } from './glossary';
import type { LlmProvider, LlmRequest, LlmResponse } from './llm/types';
import { buildClassifyPrompt, buildDraftPrompt, buildExplainPrompt } from './prompts';
import { chartFor, extractJson, normalizeSqlForCompare, templateExplanation } from './result-utils';
import { renderSchema, selectTables } from './schema-context';

export interface AgentDeps {
  llm: LlmProvider;
  warehouse: pg.Pool;
  catalog: CatalogProvider;
  glossary: GlossaryStore;
  checkpointer: BaseCheckpointSaver;
  limits: RunOptions;
  /** how many times the model may redraft after every candidate was rejected or failed */
  maxRetries?: number;
  /** write a plain-English explanation of the final SQL (one extra LLM call). Evals turn this off. */
  explain?: boolean;
}

export interface GraphHooks {
  emit(runId: string, event: RunEvent): void;
  track(runId: string, res: LlmResponse): void;
}

interface CandidateResult extends TabularResult {
  candidateId: string;
  fingerprint: string;
  durationMs: number;
}

interface ClassifyOption {
  id: string;
  meaning: string;
}

const last = <T,>(def: () => T) => Annotation<T>({ reducer: (_a: T, b: T) => b, default: def });

export const AgentState = Annotation.Root({
  runId: last<string>(() => ''),
  userId: last<string | null>(() => null),
  question: last<string>(() => ''),
  mode: last<AgentMode>(() => 'execution'),
  asOf: last<string>(() => ''),
  schemaText: last<string>(() => ''),
  glossary: last<GlossaryTerm[]>(() => []),
  ambiguousTerm: last<string | null>(() => null),
  singleReading: last<boolean>(() => false),
  clarificationText: last<string>(() => ''),
  classifyQuestion: last<string>(() => ''),
  classifyOptions: last<ClassifyOption[]>(() => []),
  candidates: last<Candidate[]>(() => []),
  results: last<CandidateResult[]>(() => []),
  failures: last<string[]>(() => []),
  retries: last<number>(() => 0),
  decision: last<'agree' | 'ask' | null>(() => null),
  clarification: last<Clarification | null>(() => null),
  pickedId: last<string | null>(() => null),
  freeText: last<string | null>(() => null),
  answer: last<AnswerPayload | null>(() => null),
  error: last<string | null>(() => null),
});

type S = typeof AgentState.State;
type U = Partial<S>;

export interface ResumeInput {
  optionId?: string;
  freeText?: string;
}

const RELATIVE_DATE = /\b(last|this|previous|past|current|yesterday|today|recent|ytd|year to date|month to date)\b/i;

function zodMessage(e: unknown): string {
  if (e instanceof z.ZodError) return e.issues.map((i) => `${i.path.join('.') || 'reply'}: ${i.message}`).join('; ');
  return e instanceof Error ? e.message : String(e);
}

export function buildGraph(deps: AgentDeps, hooks: GraphHooks) {
  const maxRetries = deps.maxRetries ?? 2;

  async function llmCall(runId: string, req: LlmRequest): Promise<string> {
    const res = await deps.llm.complete(req);
    hooks.track(runId, res);
    return res.text;
  }

  /** Ask for JSON, validate it with Zod, and give the model one chance to repair an invalid reply. */
  async function callJson<T>(runId: string, task: LlmRequest['task'], system: string, user: string, schema: z.ZodType<T>): Promise<T> {
    let problem = '';
    for (let attempt = 0; attempt < 2; attempt++) {
      const text = await llmCall(runId, {
        task,
        system,
        user: attempt === 0 ? user : `${user}\n\nYour previous reply was not valid (${problem}). Reply again with ONE valid JSON object only.`,
        json: true,
        temperature: 0,
      });
      try {
        return schema.parse(extractJson(text));
      } catch (e) {
        problem = zodMessage(e).slice(0, 300);
      }
    }
    throw new Error(`The model returned an invalid reply twice (${problem}).`);
  }

  /** Wrap a node so each run streams "step started / step finished" events for the trace drawer. */
  function traced(node: string, label: string, fn: (s: S) => Promise<{ update: U; detail?: string }>) {
    return async (s: S): Promise<U> => {
      const t0 = Date.now();
      hooks.emit(s.runId, { type: 'step', node, label, status: 'start' });
      try {
        const { update, detail } = await fn(s);
        hooks.emit(s.runId, { type: 'step', node, label, status: 'end', ms: Date.now() - t0, detail });
        return update;
      } catch (e) {
        if (!isGraphInterrupt(e)) hooks.emit(s.runId, { type: 'step', node, label, status: 'end', ms: Date.now() - t0, detail: `failed: ${(e as Error).message}` });
        throw e;
      }
    };
  }

  /* ----------------------------- nodes ----------------------------- */

  const loadContext = traced('loadContext', 'Reading schema and glossary', async (s) => {
    const catalog = await deps.catalog();
    const tables = selectTables(s.question, catalog);
    const glossary = await deps.glossary.approvedMatching(s.question);
    for (const g of glossary) hooks.emit(s.runId, { type: 'assumption', text: `Using your definition: ${g.term} = ${g.definition}` });
    return {
      update: { asOf: catalog.asOf, schemaText: renderSchema(tables), glossary, singleReading: s.mode === 'baseline', retries: 0, failures: [], candidates: [], results: [] },
      detail: `${tables.length} tables, ${glossary.length} saved definition${glossary.length === 1 ? '' : 's'}, data as of ${catalog.asOf}`,
    };
  });

  const classify = traced('classify', 'Asking the model: is this ambiguous?', async (s) => {
    const p = buildClassifyPrompt({ question: s.question, asOf: s.asOf, schemaText: s.schemaText, glossary: s.glossary });
    const out = await callJson(s.runId, 'classify', p.system, p.user, ClassifyResponseSchema);
    const options = (out.options ?? []).map((o, i) => ({ id: `o${i + 1}`, meaning: o.meaning }));
    if (out.ambiguous && options.length >= 2) {
      return {
        update: { classifyOptions: options, classifyQuestion: out.question ?? 'Which of these do you mean?', ambiguousTerm: out.ambiguous_term ?? null },
        detail: `ambiguous: ${options.length} possible meanings`,
      };
    }
    return { update: { classifyOptions: [], singleReading: true }, detail: 'not ambiguous' };
  });

  const draft = traced('draft', 'Drafting SQL readings', async (s) => {
    const single = s.singleReading || s.mode !== 'execution';
    const p = buildDraftPrompt({
      question: s.question,
      asOf: s.asOf,
      schemaText: s.schemaText,
      glossary: s.glossary,
      clarification: s.clarificationText || undefined,
      single,
      failures: s.failures,
    });
    const out = await callJson(s.runId, 'draft', p.system, p.user, DraftResponseSchema);
    const seen = new Set<string>();
    const readings = out.readings
      .filter((r) => {
        const k = normalizeSqlForCompare(r.sql);
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      })
      .slice(0, single ? 1 : 4);
    const candidates: Candidate[] = readings.map((r, i) => ({
      id: `c${i + 1}`,
      meaning: r.meaning,
      sql: r.sql,
      assumptions: r.assumptions ?? [],
      status: 'pending',
    }));
    return {
      update: {
        candidates,
        results: [],
        failures: [],
        ambiguousTerm: s.ambiguousTerm ?? out.ambiguous_term ?? null,
      },
      detail: `${candidates.length} reading${candidates.length === 1 ? '' : 's'}`,
    };
  });

  const execute = traced('execute', 'Checking and running the SQL', async (s) => {
    const policy = policyFromCatalog(await deps.catalog());
    const candidates = s.candidates.map((c) => ({ ...c }));
    const results: CandidateResult[] = [];
    await Promise.all(
      candidates.map(async (c) => {
        const g = await guardSql(c.sql, policy);
        if (!g.ok) {
          c.status = 'rejected';
          c.error = g.message;
          return;
        }
        c.sql = g.sql;
        try {
          const r = await runReadOnly(deps.warehouse, g.sql, deps.limits);
          results.push({ candidateId: c.id, columns: r.columns, rows: r.rows, rowCount: r.rowCount, truncated: r.truncated, durationMs: r.durationMs, fingerprint: resultFingerprint(r.rows) });
          c.status = 'ok';
          c.rowCount = r.rowCount;
        } catch (e) {
          c.status = 'error';
          c.error = e instanceof QueryError ? e.message : 'The query failed to run.';
        }
      }),
    );
    results.sort((a, b) => a.candidateId.localeCompare(b.candidateId));
    hooks.emit(s.runId, { type: 'candidates', candidates });
    const ok = candidates.filter((c) => c.status === 'ok').length;
    const failures = candidates.filter((c) => c.status !== 'ok').map((c) => `${c.sql.replace(/\s+/g, ' ').slice(0, 500)}  ->  ${c.error}`);
    return {
      update: { candidates, results, failures: ok ? [] : failures, retries: ok ? s.retries : s.retries + 1 },
      detail: `${ok} of ${candidates.length} ran successfully`,
    };
  });

  const compare = traced('compare', 'Comparing the results', async (s) => {
    const ok = s.results;
    const groups = new Set(ok.map((r) => r.fingerprint));
    const ask = s.mode === 'execution' && groups.size > 1;
    return {
      update: { decision: ask ? ('ask' as const) : ('agree' as const) },
      detail: ask ? `${groups.size} readings give different results: asking you` : ok.length > 1 ? 'all readings give the same rows: no question needed' : 'one reading',
    };
  });

  const prepareAsk = traced('prepareAsk', 'Preparing a question for you', async (s) => {
    let options: ClarificationOption[];
    let question: string;
    if (s.mode === 'classifier') {
      options = s.classifyOptions.map((o) => ({ id: o.id, meaning: o.meaning }));
      question = s.classifyQuestion;
    } else {
      const seen = new Set<string>();
      options = [];
      for (const r of s.results) {
        if (seen.has(r.fingerprint)) continue;
        seen.add(r.fingerprint);
        const c = s.candidates.find((x) => x.id === r.candidateId)!;
        options.push({
          id: c.id,
          meaning: c.meaning,
          sql: c.sql,
          preview: { columns: r.columns as ColumnMeta[], rows: r.rows.slice(0, 3), rowCount: r.rowCount },
        });
      }
      question = s.ambiguousTerm
        ? `"${s.ambiguousTerm}" can mean different things here, and they give different answers. Which did you mean?`
        : 'Your question can be read more than one way, and the readings give different answers. Which did you mean?';
    }
    const clarification: Clarification = { id: randomUUID(), question, term: s.ambiguousTerm, options, allowFreeText: true };
    hooks.emit(s.runId, { type: 'clarification_needed', clarification });
    return { update: { clarification }, detail: `${options.length} options` };
  });

  // Not traced: interrupt() pauses the graph by throwing, and on resume this function runs again from the top.
  // Nothing before interrupt() may have side effects.
  const ask = async (s: S): Promise<U> => {
    const reply = interrupt({ clarificationId: s.clarification?.id, options: s.clarification?.options.map((o) => o.id) ?? [] }) as ResumeInput;
    const options = s.clarification?.options ?? [];
    const base: U = { retries: 0, failures: [], decision: null };
    if (reply?.optionId && options.some((o) => o.id === reply.optionId)) {
      const picked = options.find((o) => o.id === reply.optionId)!;
      if (s.mode === 'execution') return { ...base, pickedId: picked.id, freeText: null };
      return { ...base, pickedId: picked.id, freeText: null, clarificationText: picked.meaning, singleReading: true, candidates: [], results: [] };
    }
    if (reply?.freeText) {
      return { ...base, pickedId: null, freeText: reply.freeText, clarificationText: reply.freeText, singleReading: true, candidates: [], results: [] };
    }
    throw new Error('The clarification answer did not match any option.');
  };

  const answer = traced('respond', 'Writing the answer', async (s) => {
    const okResults = s.results;
    const chosenResult = (s.pickedId && okResults.find((r) => r.candidateId === s.pickedId)) || okResults[0];
    if (!chosenResult) throw new Error('No successful query to answer with.');
    const cand = s.candidates.find((c) => c.id === chosenResult.candidateId)!;

    const result: TabularResult = { columns: chosenResult.columns, rows: chosenResult.rows, rowCount: chosenResult.rowCount, truncated: chosenResult.truncated };

    let path: AnswerPayload['path'] = 'single-reading';
    let considered: string[] = [];
    if (s.freeText) path = 'user-free-text';
    else if (s.pickedId || s.clarificationText) path = 'user-clarified';
    else {
      const same = okResults.filter((r) => r.fingerprint === chosenResult.fingerprint && r.candidateId !== chosenResult.candidateId);
      if (same.length) {
        path = 'readings-agree';
        considered = same.map((r) => s.candidates.find((c) => c.id === r.candidateId)!.meaning);
      }
    }

    const assumptions = [...cand.assumptions];
    if (RELATIVE_DATE.test(s.question) && !assumptions.some((a) => a.includes(s.asOf))) {
      assumptions.push(`Dates are relative to ${s.asOf}, the latest order in the data`);
    }
    for (const a of assumptions) hooks.emit(s.runId, { type: 'assumption', text: a });

    let explanation = '';
    if (deps.explain !== false) {
      try {
        const p = buildExplainPrompt({ question: s.question, sql: cand.sql, columns: result.columns.map((c) => c.name), assumptions });
        explanation = (await llmCall(s.runId, { task: 'explain', system: p.system, user: p.user, json: false, temperature: 0 })).trim().slice(0, 900);
      } catch {
        explanation = '';
      }
      if (!explanation) explanation = templateExplanation(s.question, cand.sql, assumptions);
    }

    // Remember what the user chose so the same question does not need asking next time (an admin approves it first).
    if ((path === 'user-clarified' || path === 'user-free-text') && s.ambiguousTerm) {
      try {
        await deps.glossary.propose({
          term: s.ambiguousTerm,
          definition: s.freeText || s.clarificationText || cand.meaning,
          source: 'clarification',
          createdBy: s.userId,
        });
      } catch {
        /* learning is best effort */
      }
    }

    const payload: AnswerPayload = {
      sql: cand.sql,
      meaning: cand.meaning,
      assumptions,
      result,
      chart: chartFor(result),
      explanation,
      path,
      consideredReadings: considered,
    };
    hooks.emit(s.runId, { type: 'result', result: payload });
    return { update: { answer: payload }, detail: `${result.rowCount} row${result.rowCount === 1 ? '' : 's'}` };
  });

  const fail = traced('fail', 'Could not produce a working query', async (s) => {
    const lastProblem = s.failures[0]?.split('  ->  ')[1] ?? 'the model did not produce valid SQL';
    const error = `I couldn't produce a working query for that question. Last problem: ${lastProblem}`;
    hooks.emit(s.runId, { type: 'error', message: error });
    return { update: { error }, detail: lastProblem };
  });

  const graph = new StateGraph(AgentState)
    .addNode('loadContext', loadContext)
    .addNode('classify', classify)
    .addNode('draft', draft)
    .addNode('execute', execute)
    .addNode('compare', compare)
    .addNode('prepareAsk', prepareAsk)
    .addNode('ask', ask)
    .addNode('respond', answer)
    .addNode('fail', fail)
    .addEdge(START, 'loadContext')
    .addConditionalEdges('loadContext', (s) => (s.mode === 'classifier' ? 'classify' : 'draft'), ['classify', 'draft'])
    .addConditionalEdges('classify', (s) => (s.classifyOptions.length >= 2 ? 'prepareAsk' : 'draft'), ['prepareAsk', 'draft'])
    .addEdge('draft', 'execute')
    .addConditionalEdges(
      'execute',
      (s) => (s.results.length > 0 ? 'compare' : s.retries <= maxRetries ? 'draft' : 'fail'),
      ['compare', 'draft', 'fail'],
    )
    .addConditionalEdges('compare', (s) => (s.decision === 'ask' ? 'prepareAsk' : 'respond'), ['prepareAsk', 'respond'])
    .addEdge('prepareAsk', 'ask')
    .addConditionalEdges('ask', (s) => (s.mode === 'execution' && s.pickedId ? 'respond' : 'draft'), ['respond', 'draft'])
    .addEdge('respond', END)
    .addEdge('fail', END)
    .compile({ checkpointer: deps.checkpointer });

  return graph;
}
