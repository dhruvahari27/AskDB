import pg from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { getConfig } from '@askdb/shared';
import { createReadOnlyPool, QueryError, runReadOnly } from '../src/execute';

const url = getConfig().WAREHOUSE_READONLY_URL;

let available = false;
try {
  const probe = new pg.Client({ connectionString: url, connectionTimeoutMillis: 1500 });
  await probe.connect();
  const { rows } = await probe.query("SELECT to_regclass('analytics.orders') AS t");
  available = Boolean(rows[0].t);
  await probe.end();
} catch {
  available = false;
}

const opts = { timeoutMs: 5000, maxRows: 500, maxPlanCost: 5_000_000 };
const pool = createReadOnlyPool(url, 2);
afterAll(async () => {
  await pool.end();
});

describe.skipIf(!available)('runReadOnly (needs the warehouse: run `npm run setup`)', () => {
  it('returns typed columns and array rows', async () => {
    const r = await runReadOnly(pool, "SELECT order_status, count(*) AS n, min(order_purchase_timestamp) AS first FROM orders GROUP BY 1 ORDER BY 2 DESC", opts);
    expect(r.columns.map((c) => c.type)).toEqual(['text', 'number', 'date']);
    expect(typeof r.rows[0]![1]).toBe('number');
    expect(typeof r.rows[0]![2]).toBe('string');
  });

  it('caps rows and reports truncation', async () => {
    const r = await runReadOnly(pool, 'SELECT order_id FROM orders', { ...opts, maxRows: 10 });
    expect(r.rowCount).toBe(10);
    expect(r.truncated).toBe(true);
  });

  it('survives a trailing line comment (the wrapper puts the closing paren on its own line)', async () => {
    const r = await runReadOnly(pool, 'SELECT 1 AS one -- comment', opts);
    expect(r.rows).toEqual([[1]]);
  });

  it('stops queries that run too long', async () => {
    await expect(
      runReadOnly(pool, 'SELECT count(*) FROM generate_series(1, 300000000)', { ...opts, timeoutMs: 300, maxPlanCost: 1e12 }),
    ).rejects.toMatchObject({ code: 'timeout' });
  });

  it('rejects plans that look too expensive before running them', async () => {
    await expect(
      runReadOnly(pool, 'SELECT count(*) FROM orders a, orders b, orders c, orders d', opts),
    ).rejects.toMatchObject({ code: 'too_expensive' });
  });

  it('reports SQL errors as one safe line', async () => {
    const err = await runReadOnly(pool, 'SELECT nope FROM orders', opts).catch((e) => e);
    expect(err).toBeInstanceOf(QueryError);
    expect(err.code).toBe('sql_error');
    expect(err.message).toMatch(/column "nope" does not exist/);
    expect(err.message).not.toContain('\n');
  });

  it('the read-only role cannot write even if every other check failed', async () => {
    await expect(pool.query("DELETE FROM analytics.orders WHERE order_id = 'x'")).rejects.toThrow(/read-only|permission denied/);
    await expect(pool.query("UPDATE analytics.orders SET order_status = 'x'")).rejects.toThrow(/read-only|permission denied/);
    await expect(pool.query('CREATE TABLE analytics.evil (a int)')).rejects.toThrow(/read-only|permission denied/);
  });

  it('the read-only role cannot read the app database tables or public schema', async () => {
    await expect(pool.query('SELECT * FROM public.schema_migrations')).rejects.toThrow();
  });
});
