import { Command } from '@langchain/langgraph';
import type { AgentMode, AnswerPayload, Clarification, RunEvent, Usage } from '@askdb/shared';
import { buildGraph, type AgentDeps, type ResumeInput } from './graph';

export type RunOutcome =
  | { status: 'complete'; answer: AnswerPayload; usage: Usage; durationMs: number }
  | { status: 'awaiting_clarification'; clarification: Clarification; usage: Usage; durationMs: number }
  | { status: 'failed'; error: string; usage: Usage; durationMs: number };

export interface StartInput {
  runId: string;
  question: string;
  mode: AgentMode;
  userId?: string | null;
}

type Listener = (event: RunEvent) => void;

/**
 * Thin, framework-free wrapper around the graph. The API, the eval harness and the MCP server all use this,
 * so every entry point gets the same behaviour.
 */
export class AgentRunner {
  private listeners = new Map<string, Listener>();
  private usage = new Map<string, Usage>();
  private graph: ReturnType<typeof buildGraph>;

  constructor(private deps: AgentDeps) {
    this.graph = buildGraph(deps, {
      emit: (runId, event) => this.listeners.get(runId)?.(event),
      track: (runId, res) => {
        const u = this.usageOf(runId);
        u.inputTokens += res.inputTokens;
        u.outputTokens += res.outputTokens;
        u.llmCalls += 1;
      },
    });
  }

  private usageOf(runId: string): Usage {
    let u = this.usage.get(runId);
    if (!u) {
      u = { inputTokens: 0, outputTokens: 0, llmCalls: 0 };
      this.usage.set(runId, u);
    }
    return u;
  }

  usageFor(runId: string): Usage {
    return { ...this.usageOf(runId) };
  }

  forget(runId: string): void {
    this.usage.delete(runId);
    this.listeners.delete(runId);
  }

  async start(input: StartInput, onEvent: Listener = () => {}): Promise<RunOutcome> {
    return this.drive(input.runId, onEvent, () =>
      this.graph.invoke(
        { runId: input.runId, question: input.question, mode: input.mode, userId: input.userId ?? null },
        { configurable: { thread_id: input.runId }, recursionLimit: 40 },
      ),
    );
  }

  async resume(runId: string, reply: ResumeInput, onEvent: Listener = () => {}): Promise<RunOutcome> {
    return this.drive(runId, onEvent, () =>
      this.graph.invoke(new Command({ resume: reply }), { configurable: { thread_id: runId }, recursionLimit: 40 }),
    );
  }

  /** Is this run currently paused waiting for a clarification? */
  async pendingClarification(runId: string): Promise<Clarification | null> {
    const snap = await this.graph.getState({ configurable: { thread_id: runId } });
    const paused = snap.tasks.some((t) => (t.interrupts?.length ?? 0) > 0);
    return paused ? (snap.values.clarification ?? null) : null;
  }

  private async drive(runId: string, onEvent: Listener, run: () => Promise<unknown>): Promise<RunOutcome> {
    const started = Date.now();
    // Usage is reported per segment (the start, or one resume), so callers can simply add segments up.
    this.usage.set(runId, { inputTokens: 0, outputTokens: 0, llmCalls: 0 });
    this.listeners.set(runId, onEvent);
    const finish = (outcome: RunOutcome): RunOutcome => {
      onEvent({ type: 'done', status: outcome.status === 'failed' ? 'failed' : outcome.status, usage: outcome.usage, durationMs: outcome.durationMs });
      this.listeners.delete(runId);
      return outcome;
    };
    try {
      await run();
      const snap = await this.graph.getState({ configurable: { thread_id: runId } });
      const usage = this.usageFor(runId);
      const durationMs = Date.now() - started;
      const paused = snap.tasks.some((t) => (t.interrupts?.length ?? 0) > 0);
      if (paused && snap.values.clarification) return finish({ status: 'awaiting_clarification', clarification: snap.values.clarification, usage, durationMs });
      if (snap.values.answer) return finish({ status: 'complete', answer: snap.values.answer, usage, durationMs });
      return finish({ status: 'failed', error: snap.values.error ?? 'The run ended without an answer.', usage, durationMs });
    } catch (e) {
      const error = friendlyError(e);
      onEvent({ type: 'error', message: error });
      return finish({ status: 'failed', error, usage: this.usageFor(runId), durationMs: Date.now() - started });
    }
  }
}

export function friendlyError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  if ((e as Error)?.name === 'LlmError') return msg;
  if (/invalid reply/i.test(msg)) return msg;
  // Anything else is an internal problem: do not leak details to the user.
  return 'Something went wrong while answering. Please try again.';
}
