import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { Router } from 'express';
import { repoRoot } from '@askdb/shared';
import { requireAdmin, requireAuth } from '../auth';
import type { ApiDeps } from '../deps';
import { HttpError } from '../http';

const RESULTS_DIR = resolve(repoRoot, 'packages/evals/results');
const DATASET = resolve(repoRoot, 'packages/evals/data/cases.json');

export function metaRouter(d: ApiDeps): Router {
  const r = Router();

  r.get('/health', async (_req, res) => {
    const checks: Record<string, string> = {};
    try {
      await d.db.query('SELECT 1');
      checks.appDatabase = 'ok';
    } catch {
      checks.appDatabase = 'down';
    }
    try {
      await d.catalog();
      checks.warehouse = 'ok';
    } catch {
      checks.warehouse = 'down';
    }
    const ok = Object.values(checks).every((v) => v === 'ok');
    res.status(ok ? 200 : 503).json({ status: ok ? 'ok' : 'degraded', checks, provider: d.providerLabel });
  });

  r.use(requireAuth);

  r.get('/schema', async (_req, res) => {
    const c = await d.catalog();
    res.json({
      schema: c.schema,
      asOf: c.asOf,
      tables: c.tables.map((t) => ({
        name: t.name,
        description: t.description,
        rowEstimate: t.rowEstimate,
        columns: t.columns.map((col) => ({ name: col.name, type: col.type, description: col.description, pii: col.pii, isPk: col.isPk, fk: col.fk ?? null })),
      })),
    });
  });

  r.get('/stats', async (req, res) => {
    const uid = req.user!.id;
    const [totalsRes, todayRes, glossaryRes, recentRes, perDayRes, asOfRes] = await Promise.all([
      d.db.query(
        `SELECT count(*)::int AS runs,
                count(*) FILTER (WHERE status = 'complete')::int AS completed,
                count(*) FILTER (WHERE status = 'failed')::int AS failed,
                count(*) FILTER (WHERE EXISTS (SELECT 1 FROM clarifications c WHERE c.run_id = q.id))::int AS clarified,
                COALESCE(avg(duration_ms) FILTER (WHERE status = 'complete'), 0)::int AS "avgDurationMs",
                COALESCE(sum(input_tokens + output_tokens), 0)::int AS tokens
           FROM query_runs q WHERE user_id = $1`,
        [uid],
      ),
      d.db.query(
        `SELECT COALESCE(SUM(input_tokens + output_tokens), 0)::int AS n FROM query_runs WHERE user_id = $1 AND created_at >= date_trunc('day', now())`,
        [uid],
      ),
      d.db.query(`SELECT count(*) FILTER (WHERE status = 'approved')::int AS approved, count(*) FILTER (WHERE status = 'proposed')::int AS proposed FROM glossary_terms`),
      d.db.query(
        `SELECT id, question, status, mode, duration_ms AS "durationMs", row_count AS "rowCount", conversation_id AS "conversationId", created_at AS "createdAt",
                EXISTS (SELECT 1 FROM clarifications c WHERE c.run_id = q.id) AS clarified
           FROM query_runs q WHERE user_id = $1 ORDER BY created_at DESC LIMIT 8`,
        [uid],
      ),
      d.db.query(
        `SELECT to_char(day, 'YYYY-MM-DD') AS day,
                (SELECT count(*)::int FROM query_runs q WHERE q.user_id = $1 AND q.created_at >= day AND q.created_at < day + interval '1 day') AS runs,
                (SELECT count(*)::int FROM query_runs q WHERE q.user_id = $1 AND q.created_at >= day AND q.created_at < day + interval '1 day'
                    AND EXISTS (SELECT 1 FROM clarifications c WHERE c.run_id = q.id)) AS clarified
           FROM generate_series(date_trunc('day', now()) - interval '6 days', date_trunc('day', now()), interval '1 day') AS day ORDER BY day`,
        [uid],
      ),
      d.catalog().catch(() => null),
    ]);
    res.json({
      totals: totalsRes.rows[0],
      tokensToday: todayRes.rows[0].n as number,
      tokenBudget: d.cfg.DAILY_TOKEN_BUDGET,
      glossary: glossaryRes.rows[0],
      recent: recentRes.rows,
      perDay: perDayRes.rows,
      asOf: asOfRes?.asOf ?? null,
      provider: d.providerLabel,
    });
  });

  r.get('/evals/dataset', (_req, res) => {
    if (!existsSync(DATASET)) return res.json({ total: 0, clear: 0, ambiguous: 0, byType: {} });
    const cases = JSON.parse(readFileSync(DATASET, 'utf8')) as { isAmbiguous: boolean; ambiguityType?: string; split?: string }[];
    const byType: Record<string, number> = {};
    for (const c of cases) if (c.isAmbiguous && c.ambiguityType) byType[c.ambiguityType] = (byType[c.ambiguityType] ?? 0) + 1;
    res.json({
      total: cases.length,
      clear: cases.filter((c) => !c.isAmbiguous).length,
      ambiguous: cases.filter((c) => c.isAmbiguous).length,
      heldOut: cases.filter((c) => c.split === 'test').length,
      byType,
    });
  });

  r.get('/evals/runs', (_req, res) => {
    if (!existsSync(RESULTS_DIR)) return res.json({ runs: [] });
    const runs = readdirSync(RESULTS_DIR)
      .filter((f) => f.endsWith('.json'))
      .map((f) => {
        try {
          const j = JSON.parse(readFileSync(resolve(RESULTS_DIR, f), 'utf8'));
          return { id: f.replace(/\.json$/, ''), startedAt: j.startedAt, provider: j.provider, model: j.model, commit: j.commit, cases: j.cases, modes: j.summary };
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .sort((a, b) => String(b!.startedAt).localeCompare(String(a!.startedAt)));
    res.json({ runs });
  });

  r.get('/evals/runs/:id', (req, res) => {
    const id = String(req.params.id);
    if (!/^[A-Za-z0-9_.-]+$/.test(id)) throw new HttpError(404, 'Not found');
    const file = resolve(RESULTS_DIR, `${id}.json`);
    if (!existsSync(file)) throw new HttpError(404, 'Eval run not found.');
    res.json(JSON.parse(readFileSync(file, 'utf8')));
  });

  r.get('/feedback/corrections', requireAdmin, async (_req, res) => {
    const { rows } = await d.db.query(
      `SELECT f.id, f.rating, f.corrected_sql AS "correctedSql", f.note, f.created_at AS "createdAt",
              (SELECT question FROM query_runs q WHERE q.id = m.run_id) AS question,
              (m.result -> 'answer' ->> 'sql') AS "predictedSql"
         FROM feedback f JOIN messages m ON m.id = f.message_id
        WHERE f.corrected_sql IS NOT NULL ORDER BY f.created_at DESC LIMIT 100`,
    );
    res.json({ corrections: rows });
  });

  return r;
}
