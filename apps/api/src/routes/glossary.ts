import { Router } from 'express';
import { GlossaryCreateBody, GlossaryPatchBody } from '@askdb/shared/schemas';
import { requireAdmin, requireAuth } from '../auth';
import type { ApiDeps } from '../deps';
import { HttpError, parseBody, uuidParam } from '../http';

const COLS = `g.id, g.term, g.definition, g.sql_snippet AS "sqlSnippet", g.status, g.source, g.created_at AS "createdAt",
              cu.email AS "createdByEmail", au.email AS "approvedByEmail"`;
const FROM = `FROM glossary_terms g LEFT JOIN users cu ON cu.id = g.created_by LEFT JOIN users au ON au.id = g.approved_by`;

export function glossaryRouter(d: ApiDeps): Router {
  const r = Router();
  r.use(requireAuth);

  r.get('/glossary', async (req, res) => {
    const status = typeof req.query.status === 'string' ? req.query.status : null;
    if (status && !['proposed', 'approved', 'rejected'].includes(status)) throw new HttpError(400, 'Unknown status.');
    const { rows } = await d.db.query(`SELECT ${COLS} ${FROM} WHERE ($1::text IS NULL OR g.status = $1) ORDER BY g.status, g.term, g.created_at DESC`, [status]);
    res.json({ terms: rows });
  });

  r.post('/glossary', async (req, res) => {
    const body = parseBody(GlossaryCreateBody, req.body);
    const admin = req.user!.role === 'admin';
    const { rows } = await d.db.query(
      `INSERT INTO glossary_terms (term, definition, sql_snippet, status, source, created_by, approved_by)
       VALUES ($1, $2, $3, $4, 'manual', $5, $6)
       ON CONFLICT (term, definition) DO NOTHING RETURNING id`,
      [body.term.toLowerCase(), body.definition, body.sqlSnippet ?? null, admin ? 'approved' : 'proposed', req.user!.id, admin ? req.user!.id : null],
    );
    if (!rows[0]) throw new HttpError(409, 'That definition already exists.');
    const term = (await d.db.query(`SELECT ${COLS} ${FROM} WHERE g.id = $1`, [rows[0].id])).rows[0];
    res.status(201).json({ term });
  });

  r.patch('/glossary/:id', requireAdmin, async (req, res) => {
    const id = uuidParam(req.params.id);
    const body = parseBody(GlossaryPatchBody, req.body);
    const { rowCount } = await d.db.query(
      `UPDATE glossary_terms SET
          status = COALESCE($2, status),
          definition = COALESCE($3, definition),
          term = COALESCE($4, term),
          approved_by = CASE WHEN $2 = 'approved' THEN $5::uuid WHEN $2 IS NOT NULL THEN NULL ELSE approved_by END
        WHERE id = $1`,
      [id, body.status ?? null, body.definition ?? null, body.term?.toLowerCase() ?? null, req.user!.id],
    ).catch((e: { code?: string }) => {
      if (e.code === '23505') throw new HttpError(409, 'That term and definition already exist.');
      throw e;
    });
    if (!rowCount) throw new HttpError(404, 'Term not found.');
    const term = (await d.db.query(`SELECT ${COLS} ${FROM} WHERE g.id = $1`, [id])).rows[0];
    res.json({ term });
  });

  r.delete('/glossary/:id', requireAdmin, async (req, res) => {
    const id = uuidParam(req.params.id);
    const { rowCount } = await d.db.query('DELETE FROM glossary_terms WHERE id = $1', [id]);
    if (!rowCount) throw new HttpError(404, 'Term not found.');
    res.json({ ok: true });
  });

  return r;
}
