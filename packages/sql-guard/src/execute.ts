import pg from 'pg';
import type { Cell, ColumnMeta, ColumnType, TabularResult } from '@askdb/shared';

/** Errors that are safe to show: they describe what was wrong with the query, never infrastructure. */
export class QueryError extends Error {
  constructor(
    public code: 'timeout' | 'too_expensive' | 'write_blocked' | 'sql_error',
    message: string,
  ) {
    super(message);
    this.name = 'QueryError';
  }
}

export interface RunOptions {
  timeoutMs: number;
  maxRows: number;
  maxPlanCost: number;
}

export interface RunResult extends TabularResult {
  durationMs: number;
  planCost: number;
}

// Keep dates/timestamps as the strings Postgres prints (no timezone shifts), and numbers as JS numbers.
const customTypes = {
  getTypeParser(oid: number, format?: 'text' | 'binary') {
    if (oid === 20 || oid === 21 || oid === 23) return (v: string) => Number(v);
    if (oid === 700 || oid === 701 || oid === 1700) return (v: string) => Number(v);
    if (oid === 1082 || oid === 1114 || oid === 1184) return (v: string) => v;
    return pg.types.getTypeParser(oid, format as 'text');
  },
};

export function createReadOnlyPool(connectionString: string, max = 6): pg.Pool {
  return new pg.Pool({
    connectionString,
    max,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    types: customTypes,
  });
}

function columnType(oid: number): ColumnType {
  if ([20, 21, 23, 26, 700, 701, 1700].includes(oid)) return 'number';
  if ([1082, 1114, 1184].includes(oid)) return 'date';
  if (oid === 16) return 'boolean';
  return 'text';
}

/**
 * Run an already-guarded SELECT. Independent safety layers, innermost first:
 *   - the connection uses the askdb_ro role (SELECT only, read-only by default)
 *   - BEGIN READ ONLY and always ROLLBACK
 *   - statement_timeout
 *   - EXPLAIN first: reject plans above the cost ceiling
 *   - the query is wrapped so at most maxRows+1 rows ever come back
 */
export async function runReadOnly(pool: pg.Pool, sql: string, opts: RunOptions): Promise<RunResult> {
  const started = Date.now();
  const client = await pool.connect();
  try {
    await client.query('BEGIN READ ONLY');
    await client.query(`SET LOCAL statement_timeout = ${Math.max(100, Math.floor(opts.timeoutMs))}`);
    await client.query('SET LOCAL search_path = analytics');

    const plan = await client.query<{ 'QUERY PLAN': { Plan: { 'Total Cost': number } }[] }>(`EXPLAIN (FORMAT JSON)\n${sql}`);
    const planCost = Number(plan.rows[0]?.['QUERY PLAN']?.[0]?.Plan?.['Total Cost'] ?? 0);
    if (planCost > opts.maxPlanCost) {
      throw new QueryError('too_expensive', 'This query would scan too much data. Try a narrower question (filter by date or category).');
    }

    const res = await client.query({
      text: `SELECT * FROM (\n${sql}\n) AS askdb_q LIMIT ${Math.floor(opts.maxRows) + 1}`,
      rowMode: 'array',
    });
    const truncated = res.rows.length > opts.maxRows;
    const rows = (truncated ? res.rows.slice(0, opts.maxRows) : res.rows) as Cell[][];
    const columns: ColumnMeta[] = res.fields.map((f) => ({ name: f.name, type: columnType(f.dataTypeID) }));
    return { columns, rows, rowCount: rows.length, truncated, durationMs: Date.now() - started, planCost };
  } catch (e) {
    if (e instanceof QueryError) throw e;
    const err = e as { code?: string; message?: string };
    if (err.code === '57014') {
      throw new QueryError('timeout', `The query took longer than ${Math.round(opts.timeoutMs / 1000)} seconds and was stopped.`);
    }
    if (err.code === '25006') throw new QueryError('write_blocked', 'The database is read-only; this statement was blocked.');
    throw new QueryError('sql_error', (err.message ?? 'Query failed').split('\n')[0]!);
  } finally {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* connection may already be broken */
    }
    client.release();
  }
}
