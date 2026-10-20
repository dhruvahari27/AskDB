import { Router, type Response } from 'express';
import { ipKeyGenerator, rateLimit } from 'express-rate-limit';
import type { AgentMode, RunEvent } from '@askdb/shared';
import { AskBody, ClarifyBody } from '@askdb/shared/schemas';
import type { RunOutcome } from '@askdb/agent';
import { requireAuth } from '../auth';
import type { ApiDeps } from '../deps';
import { HttpError, parseBody, uuidParam } from '../http';
import type { IndexedEvent } from '../runs';
import { randomUUID } from 'node:crypto';

const TRACE_TYPES = new Set(['step', 'assumption', 'candidates']);

export function runsRouter(d: ApiDeps): Router {
  const r = Router();
  r.use(requireAuth);

  const askLimiter = rateLimit({
    windowMs: 60_000,
    limit: d.cfg.ASK_RATE_LIMIT_PER_MIN,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    keyGenerator: (req) => req.user?.id ?? ipKeyGenerator(req.ip ?? ''),
    message: { error: 'You are asking too fast. Wait a few seconds and try again.' },
  });

  async function tokensUsedToday(userId: string): Promise<number> {
    const { rows } = await d.db.query(
      `SELECT COALESCE(SUM(input_tokens + output_tokens), 0)::int AS n FROM query_runs
        WHERE user_id = $1 AND created_at >= date_trunc('day', now())`,
      [userId],
    );
    return rows[0].n as number;
  }

  /** Persist where a run ended up, THEN tell the browser it is done, so a reload right after `done` sees the final state. */
  async function persistOutcome(runId: string, outcome: RunOutcome): Promise<void> {
    const entry = d.runs.get(runId);
    const trace = (entry?.events ?? []).filter((e) => TRACE_TYPES.has(e.type)).map(({ i: _i, ...e }) => e);
    const usage = outcome.usage;
    if (outcome.status === 'complete') {
      const a = outcome.answer;
      await d.db.query(
        `UPDATE query_runs SET status = 'complete', sql = $2, row_count = $3, duration_ms = COALESCE(duration_ms, 0) + $4,
                input_tokens = input_tokens + $5, output_tokens = output_tokens + $6, llm_calls = llm_calls + $7, error = NULL, finished_at = now()
          WHERE id = $1`,
        [runId, a.sql, a.result.rowCount, outcome.durationMs, usage.inputTokens, usage.outputTokens, usage.llmCalls],
      );
      await d.db.query(
        `UPDATE messages SET status = 'complete', content = $2, result = $3 WHERE run_id = $1 AND role = 'assistant'`,
        [runId, a.meaning, JSON.stringify({ kind: 'answer', answer: a, trace })],
      );
    } else if (outcome.status === 'awaiting_clarification') {
      await d.db.query(
        `INSERT INTO clarifications (id, run_id, question, options) VALUES ($1, $2, $3, $4) ON CONFLICT (id) DO NOTHING`,
        [outcome.clarification.id, runId, outcome.clarification.question, JSON.stringify(outcome.clarification.options)],
      );
      await d.db.query(
        `UPDATE query_runs SET status = 'awaiting_clarification', duration_ms = COALESCE(duration_ms, 0) + $2,
                input_tokens = input_tokens + $3, output_tokens = output_tokens + $4, llm_calls = llm_calls + $5 WHERE id = $1`,
        [runId, outcome.durationMs, usage.inputTokens, usage.outputTokens, usage.llmCalls],
      );
      await d.db.query(
        `UPDATE messages SET status = 'awaiting_clarification', content = $2, result = $3 WHERE run_id = $1 AND role = 'assistant'`,
        [runId, outcome.clarification.question, JSON.stringify({ kind: 'clarification', clarification: outcome.clarification, trace })],
      );
    } else {
      await d.db.query(
        `UPDATE query_runs SET status = 'failed', error = $2, duration_ms = COALESCE(duration_ms, 0) + $3,
                input_tokens = input_tokens + $4, output_tokens = output_tokens + $5, llm_calls = llm_calls + $6, finished_at = now() WHERE id = $1`,
        [runId, outcome.error, outcome.durationMs, usage.inputTokens, usage.outputTokens, usage.llmCalls],
      );
      await d.db.query(
        `UPDATE messages SET status = 'failed', content = $2, result = $3 WHERE run_id = $1 AND role = 'assistant'`,
        [runId, outcome.error, JSON.stringify({ kind: 'error', message: outcome.error, trace })],
      );
    }
    await d.db.query(
      `UPDATE conversations SET updated_at = now() WHERE id = (SELECT conversation_id FROM query_runs WHERE id = $1)`,
      [runId],
    );
  }

  function launch(runId: string, drive: (onEvent: (e: RunEvent) => void) => Promise<RunOutcome>): void {
    d.runs.open(runId);
    const onEvent = (e: RunEvent) => {
      if (e.type === 'done') return; // sent below, after the outcome is saved
      d.runs.push(runId, e);
    };
    drive(onEvent)
      .then(async (outcome) => {
        await persistOutcome(runId, outcome);
        d.runs.push(runId, { type: 'done', status: outcome.status, usage: outcome.usage, durationMs: outcome.durationMs });
      })
      .catch((err) => {
        d.log.error({ err, runId }, 'run failed');
        d.runs.push(runId, { type: 'error', message: 'Something went wrong while answering. Please try again.' });
        d.runs.push(runId, { type: 'done', status: 'failed' });
        d.db.query(`UPDATE query_runs SET status = 'failed', error = 'internal error' WHERE id = $1`, [runId]).catch(() => {});
        d.db.query(`UPDATE messages SET status = 'failed', content = 'Something went wrong.' WHERE run_id = $1 AND role = 'assistant'`, [runId]).catch(() => {});
      });
  }

  r.post('/conversations/:id/ask', askLimiter, async (req, res) => {
    const convId = uuidParam(req.params.id);
    const body = parseBody(AskBody, req.body);
    const user = req.user!;
    const conv = (await d.db.query('SELECT id, title, mode FROM conversations WHERE id = $1 AND user_id = $2', [convId, user.id])).rows[0];
    if (!conv) throw new HttpError(404, 'Conversation not found.');

    const budget = d.cfg.DAILY_TOKEN_BUDGET;
    if (budget > 0) {
      const used = await tokensUsedToday(user.id);
      if (used >= budget) {
        throw new HttpError(429, `You have used today's AI budget (${used.toLocaleString()} of ${budget.toLocaleString()} tokens). It resets at midnight UTC.`);
      }
    }

    const mode = (body.mode ?? conv.mode) as AgentMode;
    const runId = randomUUID();
    await d.db.query(`INSERT INTO query_runs (id, user_id, conversation_id, question, mode) VALUES ($1, $2, $3, $4, $5)`, [runId, user.id, convId, body.question, mode]);
    const userMsg = (await d.db.query(`INSERT INTO messages (conversation_id, role, content) VALUES ($1, 'user', $2) RETURNING id, created_at AS "createdAt"`, [convId, body.question])).rows[0];
    const asstMsg = (
      await d.db.query(
        `INSERT INTO messages (conversation_id, role, content, status, run_id) VALUES ($1, 'assistant', '', 'running', $2) RETURNING id, created_at AS "createdAt"`,
        [convId, runId],
      )
    ).rows[0];
    if (conv.title === 'New conversation') {
      await d.db.query('UPDATE conversations SET title = $2, mode = $3, updated_at = now() WHERE id = $1', [convId, body.question.slice(0, 60), mode]);
    } else {
      await d.db.query('UPDATE conversations SET mode = $2, updated_at = now() WHERE id = $1', [convId, mode]);
    }

    launch(runId, (onEvent) => d.runner.start({ runId, question: body.question, mode, userId: user.id }, onEvent));
    res.status(202).json({ runId, userMessageId: userMsg.id, assistantMessageId: asstMsg.id, mode });
  });

  r.post('/runs/:id/clarify', async (req, res) => {
    const runId = uuidParam(req.params.id);
    const body = parseBody(ClarifyBody, req.body);
    const run = (await d.db.query('SELECT id, status FROM query_runs WHERE id = $1 AND user_id = $2', [runId, req.user!.id])).rows[0];
    if (!run) throw new HttpError(404, 'Run not found.');
    if (run.status !== 'awaiting_clarification') throw new HttpError(409, 'This question is not waiting for an answer.');
    const clar = (await d.db.query('SELECT id, options FROM clarifications WHERE run_id = $1 AND answered_at IS NULL ORDER BY created_at DESC LIMIT 1', [runId])).rows[0];
    if (!clar) throw new HttpError(409, 'There is no open question for this run.');
    if (body.optionId && !(clar.options as { id: string }[]).some((o) => o.id === body.optionId)) throw new HttpError(400, 'That option does not exist.');

    await d.db.query('UPDATE clarifications SET chosen_id = $2, free_text = $3, answered_at = now() WHERE id = $1', [clar.id, body.optionId ?? null, body.freeText ?? null]);
    await d.db.query(`UPDATE query_runs SET status = 'running' WHERE id = $1`, [runId]);
    await d.db.query(`UPDATE messages SET status = 'running' WHERE run_id = $1 AND role = 'assistant'`, [runId]);

    launch(runId, (onEvent) => d.runner.resume(runId, { optionId: body.optionId, freeText: body.freeText }, onEvent));
    res.status(202).json({ runId });
  });

  r.get('/runs/:id/stream', async (req, res) => {
    const runId = uuidParam(req.params.id);
    const run = (await d.db.query('SELECT id, status FROM query_runs WHERE id = $1 AND user_id = $2', [runId, req.user!.id])).rows[0];
    if (!run) throw new HttpError(404, 'Run not found.');
    const afterRaw = Number(req.query.after);
    const entryNow = d.runs.get(runId);
    // A browser attaching fresh (no ?after) only needs the current segment; earlier segments already ended (e.g. the question that paused for a clarification).
    const after = Number.isFinite(afterRaw) ? afterRaw : (entryNow?.segmentStart ?? 0) - 1;

    res.set({ 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.flushHeaders();

    const send = (e: IndexedEvent | (RunEvent & { i: number })) => {
      res.write(`id: ${e.i}\ndata: ${JSON.stringify(e)}\n\n`);
    };

    const entry = d.runs.get(runId);
    if (!entry) {
      await replayFromDb(d, runId, res, send);
      return;
    }

    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      clearInterval(heartbeat);
      entry.subscribers.delete(onEvent);
      res.end();
    };
    const onEvent = (e: IndexedEvent) => {
      if (e.i <= after) return;
      send(e);
      if (e.type === 'done') finish();
    };
    const heartbeat = setInterval(() => res.write(': ping\n\n'), 15_000);
    req.on('close', () => {
      finished = true;
      clearInterval(heartbeat);
      entry.subscribers.delete(onEvent);
    });

    for (const e of entry.events) if (e.i > after) send(e);
    if (entry.segmentDone) return finish();
    entry.subscribers.add(onEvent);
  });

  return r;
}

/** After a server restart there is no live feed; rebuild the ending from what was saved. */
async function replayFromDb(d: ApiDeps, runId: string, res: Response, send: (e: IndexedEvent) => void): Promise<void> {
  const msg = (await d.db.query(`SELECT status, result FROM messages WHERE run_id = $1 AND role = 'assistant'`, [runId])).rows[0];
  let i = 0;
  const out = (e: RunEvent) => send({ ...e, i: i++ } as IndexedEvent);
  const result = msg?.result as { kind?: string; answer?: never; clarification?: never; message?: string } | undefined;
  if (result?.kind === 'answer') {
    out({ type: 'result', result: result.answer as never });
    out({ type: 'done', status: 'complete' });
  } else if (result?.kind === 'clarification') {
    out({ type: 'clarification_needed', clarification: result.clarification as never });
    out({ type: 'done', status: 'awaiting_clarification' });
  } else if (result?.kind === 'error') {
    out({ type: 'error', message: result.message ?? 'Failed.' });
    out({ type: 'done', status: 'failed' });
  } else {
    // Saved as "running" but nothing is running it: the server restarted mid-run.
    await d.db.query(`UPDATE query_runs SET status = 'failed', error = 'interrupted by a restart' WHERE id = $1 AND status = 'running'`, [runId]);
    await d.db.query(`UPDATE messages SET status = 'failed', content = 'Interrupted by a server restart. Please ask again.', result = $2 WHERE run_id = $1 AND role = 'assistant' AND status = 'running'`, [runId, JSON.stringify({ kind: 'error', message: 'Interrupted by a server restart. Please ask again.' })]);
    out({ type: 'error', message: 'This question was interrupted by a server restart. Please ask again.' });
    out({ type: 'done', status: 'failed' });
  }
  res.end();
}
