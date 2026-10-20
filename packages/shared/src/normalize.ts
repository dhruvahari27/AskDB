import { createHash } from 'node:crypto';
import type { Cell } from './schemas';

/**
 * Result comparison used both by the clarification engine (do two readings return the same
 * rows?) and by the eval scorer (does the predicted SQL return the gold rows?).
 *
 * Rules, chosen to match how a business user would judge "same answer":
 *  - column names and column order are ignored
 *  - row order is ignored
 *  - numbers are compared at 2 decimals (so round(x, 2) and x are the same answer)
 *  - dates/timestamps compare by their ISO string
 */
export function normalizeCell(value: unknown): Cell {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return String(value);
    const r = Math.round(value * 100) / 100;
    return Object.is(r, -0) ? '0' : String(r);
  }
  if (typeof value === 'bigint') return String(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

/** Order-insensitive fingerprint of a result's rows. Column order is normalised by sorting each row's cells. */
export function resultFingerprint(rows: unknown[][]): string {
  const normalised = rows.map((row) => row.map(normalizeCell).map((c) => (c === null ? '\u0000null' : String(c))).sort().join('\u001f'));
  normalised.sort();
  const h = createHash('sha1');
  h.update(String(rows.length));
  h.update('\u001e');
  h.update(normalised.join('\u001e'));
  return h.digest('hex');
}

/** True when two results hold the same rows under the rules above. */
export function sameResult(a: unknown[][], b: unknown[][]): boolean {
  return resultFingerprint(a) === resultFingerprint(b);
}

/**
 * Normalizes text so it is safe to store in PostgreSQL databases configured with WIN1252 or UTF-8.
 * Replaces unmapped Unicode characters (non-breaking hyphens, special dashes, curly quotes) with safe equivalents.
 */
export function sanitizeForDb(val: unknown): unknown {
  if (typeof val === 'string') {
    return val
      .replace(/[\u2010\u2011\u2012\u2015\u2212]/g, '-')
      .replace(/[\u2018\u2019]/g, "'")
      .replace(/[\u201C\u201D]/g, '"')
      .replace(/\u2026/g, '...')
      .replace(/[^\x00-\x7F\xA0-\xFF\u20AC\u201A\u0192\u201E\u2026\u2020\u2021\u02C6\u2030\u0160\u2039\u0152\u017D\u2018\u2019\u201C\u201D\u2022\u2013\u2014\u02DC\u2122\u0161\u203A\u0153\u017E\u0178]/g, '');
  }
  if (Array.isArray(val)) return val.map(sanitizeForDb);
  return val;
}

