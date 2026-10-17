import type { NextFunction, Request, RequestHandler, Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import type pg from 'pg';
import { HttpError } from './http';

export interface AuthUser {
  id: string;
  email: string;
  name: string | null;
  role: 'admin' | 'analyst';
}

declare module 'express-serve-static-core' {
  interface Request {
    user?: AuthUser;
  }
}

export const COOKIE = 'askdb_token';
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export const hashPassword = (pw: string) => bcrypt.hash(pw, 10);
export const checkPassword = (pw: string, hash: string) => bcrypt.compare(pw, hash);

export function signToken(user: AuthUser, secret: string): string {
  return jwt.sign({ sub: user.id }, secret, { expiresIn: '7d' });
}

export function setAuthCookie(req: Request, res: Response, token: string): void {
  res.cookie(COOKIE, token, { httpOnly: true, sameSite: 'lax', secure: req.secure, maxAge: MAX_AGE_MS, path: '/' });
}

export function clearAuthCookie(res: Response): void {
  res.clearCookie(COOKIE, { path: '/' });
}

/** Loads the user from the cookie on every request, so a deleted user or changed role takes effect immediately. */
export function authenticate(db: pg.Pool, secret: string): RequestHandler {
  return async (req: Request, _res: Response, next: NextFunction) => {
    const token = req.cookies?.[COOKIE] as string | undefined;
    if (!token) return next();
    try {
      const payload = jwt.verify(token, secret) as { sub: string };
      const { rows } = await db.query('SELECT id, email, name, role FROM users WHERE id = $1', [payload.sub]);
      if (rows[0]) req.user = rows[0] as AuthUser;
    } catch {
      /* invalid or expired token: treated as signed out */
    }
    next();
  };
}

export const requireAuth: RequestHandler = (req, _res, next) => {
  if (!req.user) return next(new HttpError(401, 'Please sign in.'));
  next();
};

export const requireAdmin: RequestHandler = (req, _res, next) => {
  if (!req.user) return next(new HttpError(401, 'Please sign in.'));
  if (req.user.role !== 'admin') return next(new HttpError(403, 'Only an admin can do this.'));
  next();
};
