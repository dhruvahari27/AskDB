import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import { LoginBody, RegisterBody } from '@askdb/shared/schemas';
import { checkPassword, clearAuthCookie, hashPassword, setAuthCookie, signToken, type AuthUser } from '../auth';
import type { ApiDeps } from '../deps';
import { HttpError, parseBody } from '../http';

export function authRouter(d: ApiDeps): Router {
  const r = Router();
  const limiter = rateLimit({
    windowMs: 15 * 60_000,
    limit: 30,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { error: 'Too many attempts. Try again in a few minutes.' },
  });

  r.post('/register', limiter, async (req, res) => {
    const body = parseBody(RegisterBody, req.body);
    const email = body.email.toLowerCase();
    const hash = await hashPassword(body.password);
    // The first account on a fresh install becomes the admin (they approve glossary terms).
    const { rows } = await d.db.query(
      `INSERT INTO users (email, password_hash, name, role)
       VALUES ($1, $2, $3, CASE WHEN NOT EXISTS (SELECT 1 FROM users) THEN 'admin' ELSE 'analyst' END)
       ON CONFLICT (email) DO NOTHING
       RETURNING id, email, name, role`,
      [email, hash, body.name ?? email.split('@')[0]],
    );
    const user = rows[0] as AuthUser | undefined;
    if (!user) throw new HttpError(409, 'An account with this email already exists.');
    setAuthCookie(req, res, signToken(user, d.cfg.JWT_SECRET));
    res.status(201).json({ user });
  });

  r.post('/login', limiter, async (req, res) => {
    const body = parseBody(LoginBody, req.body);
    const { rows } = await d.db.query('SELECT id, email, name, role, password_hash FROM users WHERE email = $1', [body.email.toLowerCase()]);
    const row = rows[0];
    // Same message whether the email or the password is wrong.
    if (!row || !(await checkPassword(body.password, row.password_hash))) throw new HttpError(401, 'Wrong email or password.');
    const user: AuthUser = { id: row.id, email: row.email, name: row.name, role: row.role };
    setAuthCookie(req, res, signToken(user, d.cfg.JWT_SECRET));
    res.json({ user });
  });

  r.post('/logout', (_req, res) => {
    clearAuthCookie(res);
    res.json({ ok: true });
  });

  r.get('/me', (req, res) => {
    if (!req.user) throw new HttpError(401, 'Please sign in.');
    res.json({ user: req.user, provider: d.providerLabel });
  });

  return r;
}
