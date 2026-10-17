import { Router } from 'express';
import { CreateConversationBody, FeedbackBody } from '@askdb/shared/schemas';
import { z } from 'zod';
import { requireAuth } from '../auth';
import type { ApiDeps } from '../deps';
import { HttpError, parseBody, uuidParam } from '../http';

const PatchBody = z.object({ title: z.string().trim().min(1).max(200).optional(), mode: z.enum(['baseline', 'classifier', 'execution']).optional() });

export function conversationsRouter(d: ApiDeps): Router {
  const r = Router();
  r.use(requireAuth);

  async function owned(req: Express.Request & { user?: { id: string } }, id: string) {
    const { rows } = await d.db.query('SELECT id, title, mode, created_at, updated_at FROM conversations WHERE id = $1 AND user_id = $2', [id, req.user!.id]);
    if (!rows[0]) throw new HttpError(404, 'Conversation not found.');
    return rows[0];
  }

  r.get('/conversations', async (req, res) => {
    const { rows } = await d.db.query(
      `SELECT c.id, c.title, c.mode, c.updated_at AS "updatedAt", c.created_at AS "createdAt",
              (SELECT count(*)::int FROM messages m WHERE m.conversation_id = c.id AND m.role = 'user') AS "questionCount"
         FROM conversations c WHERE c.user_id = $1 ORDER BY c.updated_at DESC LIMIT 200`,
      [req.user!.id],
    );
    res.json({ conversations: rows });
  });

  r.post('/conversations', async (req, res) => {
    const body = parseBody(CreateConversationBody, req.body ?? {});
    const { rows } = await d.db.query(
      `INSERT INTO conversations (user_id, title, mode) VALUES ($1, $2, $3)
       RETURNING id, title, mode, created_at AS "createdAt", updated_at AS "updatedAt"`,
      [req.user!.id, body.title ?? 'New conversation', body.mode ?? 'execution'],
    );
    res.status(201).json({ conversation: rows[0] });
  });

  r.get('/conversations/:id', async (req, res) => {
    const id = uuidParam(req.params.id);
    const c = await owned(req, id);
    const { rows } = await d.db.query(
      `SELECT m.id, m.role, m.content, m.status, m.run_id AS "runId", m.result, m.created_at AS "createdAt",
              f.rating AS "feedbackRating", f.corrected_sql AS "correctedSql"
         FROM messages m LEFT JOIN feedback f ON f.message_id = m.id AND f.user_id = $2
        WHERE m.conversation_id = $1 ORDER BY m.created_at, m.role DESC`,
      [id, req.user!.id],
    );
    res.json({ conversation: { id: c.id, title: c.title, mode: c.mode, createdAt: c.created_at, updatedAt: c.updated_at }, messages: rows });
  });

  r.patch('/conversations/:id', async (req, res) => {
    const id = uuidParam(req.params.id);
    await owned(req, id);
    const body = parseBody(PatchBody, req.body);
    const { rows } = await d.db.query(
      `UPDATE conversations SET title = COALESCE($2, title), mode = COALESCE($3, mode), updated_at = now()
        WHERE id = $1 RETURNING id, title, mode`,
      [id, body.title ?? null, body.mode ?? null],
    );
    res.json({ conversation: rows[0] });
  });

  r.delete('/conversations/:id', async (req, res) => {
    const id = uuidParam(req.params.id);
    await owned(req, id);
    await d.db.query('DELETE FROM conversations WHERE id = $1', [id]);
    res.json({ ok: true });
  });

  r.post('/messages/:id/feedback', async (req, res) => {
    const id = uuidParam(req.params.id);
    const body = parseBody(FeedbackBody, req.body);
    const { rows } = await d.db.query(
      `SELECT m.id FROM messages m JOIN conversations c ON c.id = m.conversation_id
        WHERE m.id = $1 AND c.user_id = $2 AND m.role = 'assistant'`,
      [id, req.user!.id],
    );
    if (!rows[0]) throw new HttpError(404, 'Message not found.');
    await d.db.query(
      `INSERT INTO feedback (message_id, user_id, rating, corrected_sql, note) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (message_id, user_id) DO UPDATE
         SET rating = EXCLUDED.rating, corrected_sql = EXCLUDED.corrected_sql, note = EXCLUDED.note, created_at = now()`,
      [id, req.user!.id, body.rating, body.correctedSql ?? null, body.note ?? null],
    );
    res.json({ ok: true });
  });

  return r;
}
