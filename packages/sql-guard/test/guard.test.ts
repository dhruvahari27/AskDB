import { describe, expect, it } from 'vitest';
import { guardSql, type GuardCode } from '../src/guard';
import { policy } from './policy';

/** Each attack must be rejected, with the right reason. */
const attacks: [string, string, GuardCode][] = [
  ['delete', 'DELETE FROM orders', 'not_select'],
  ['drop table', 'DROP TABLE orders', 'not_select'],
  ['update', "UPDATE orders SET order_status = 'x'", 'not_select'],
  ['insert', "INSERT INTO orders (order_id) VALUES ('x')", 'not_select'],
  ['truncate', 'TRUNCATE orders', 'not_select'],
  ['explain analyze delete', 'EXPLAIN ANALYZE DELETE FROM orders', 'not_select'],
  ['copy to file', "COPY orders TO '/tmp/x'", 'not_select'],
  ['create table as', 'CREATE TABLE x AS SELECT * FROM orders', 'not_select'],
  ['do block', 'DO $$ BEGIN DELETE FROM orders; END $$', 'not_select'],
  ['set role', 'SET ROLE postgres', 'not_select'],
  ['call', 'CALL foo()', 'not_select'],
  ['stacked drop', 'SELECT 1; DROP TABLE orders', 'multiple_statements'],
  ['two selects', 'SELECT 1; SELECT 2', 'multiple_statements'],
  ['delete in cte', 'WITH d AS (DELETE FROM orders RETURNING *) SELECT * FROM d', 'write_in_query'],
  ['insert in cte', "WITH i AS (INSERT INTO orders (order_id) VALUES ('x') RETURNING 1) SELECT * FROM i", 'write_in_query'],
  ['update in cte', "WITH u AS (UPDATE orders SET order_status = 'x' RETURNING *) SELECT 1 FROM u", 'write_in_query'],
  ['select into', 'SELECT * INTO newtable FROM orders', 'select_into'],
  ['for update', 'SELECT * FROM orders FOR UPDATE', 'locking'],
  ['pg_sleep', 'SELECT pg_sleep(10)', 'forbidden_function'],
  ['pg_sleep in where', 'SELECT * FROM orders WHERE pg_sleep(5) IS NULL', 'forbidden_function'],
  ['quoted pg_sleep', 'select "pg_sleep"(1)', 'forbidden_function'],
  ['qualified pg_sleep', 'SELECT pg_catalog.pg_sleep(1)', 'forbidden_function'],
  ['pg_read_file', "SELECT pg_read_file('/etc/passwd')", 'forbidden_function'],
  ['pg_ls_dir as table', "SELECT * FROM pg_ls_dir('.')", 'forbidden_function'],
  ['lo_import', "SELECT lo_import('/etc/passwd')", 'forbidden_function'],
  ['dblink', "SELECT dblink('host=x', 'select 1')", 'forbidden_function'],
  ['dblink as table', "SELECT * FROM dblink('x', 'y') AS t(a int)", 'forbidden_function'],
  ['set_config', "SELECT set_config('search_path', 'public', false)", 'forbidden_function'],
  ['current_setting', "SELECT current_setting('server_version')", 'forbidden_function'],
  ['query_to_xml', "SELECT query_to_xml('select * from pg_authid', true, true, '')", 'forbidden_function'],
  ['version', 'SELECT version()', 'forbidden_function'],
  ['current_database', 'SELECT current_database()', 'forbidden_function'],
  ['nextval', "SELECT nextval('x')", 'forbidden_function'],
  ['custom qualified function', 'SELECT public.my_func()', 'forbidden_function'],
  ['repeat bomb', "SELECT repeat('x', 1000000000)", 'huge_argument'],
  ['lpad bomb', "SELECT lpad('x', 2000000000, 'y')", 'huge_argument'],
  ['series bomb', 'SELECT generate_series(1, 100000000)', 'huge_argument'],
  ['catalog table', 'SELECT * FROM pg_user', 'unknown_table'],
  ['pg_shadow', 'SELECT * FROM pg_shadow', 'unknown_table'],
  ['pg_authid joined', 'SELECT * FROM orders o, pg_authid', 'unknown_table'],
  ['unknown table', 'SELECT * FROM users', 'unknown_table'],
  ['cte shadowing a catalog table', 'WITH pg_shadow AS (SELECT * FROM pg_shadow) SELECT * FROM pg_shadow', 'unknown_table'],
  ['pg_catalog schema', 'SELECT * FROM pg_catalog.pg_user', 'schema_not_allowed'],
  ['information_schema', 'SELECT * FROM information_schema.tables', 'schema_not_allowed'],
  ['public schema', 'SELECT * FROM public.users', 'schema_not_allowed'],
  ['other schema, same table name', 'SELECT * FROM other_schema.orders', 'schema_not_allowed'],
  ['cross database', 'SELECT * FROM otherdb.analytics.orders', 'schema_not_allowed'],
  ['pii column', 'SELECT customer_zip_code_prefix FROM customers', 'pii_column'],
  ['pii column in where', "SELECT count(*) FROM customers WHERE customer_zip_code_prefix = '01310'", 'pii_column'],
  ['pii free text', 'SELECT review_comment_message FROM order_reviews', 'pii_column'],
  ['pii via alias', 'SELECT s.seller_zip_code_prefix FROM sellers s', 'pii_column'],
  ['wildcard over pii table', 'SELECT * FROM customers', 'pii_wildcard'],
  ['qualified wildcard', 'SELECT c.* FROM customers c', 'pii_wildcard'],
  ['wildcard reviews', 'SELECT * FROM order_reviews', 'pii_wildcard'],
  ['wildcard in join with pii table', 'SELECT * FROM orders o JOIN customers c USING (customer_id)', 'pii_wildcard'],
  ['whole-row reference', 'SELECT customers FROM customers', 'pii_wildcard'],
  ['whole-row via function', 'SELECT to_jsonb(c) FROM customers c', 'pii_wildcard'],
  ['empty', '', 'empty'],
  ['only semicolon', ';', 'empty'],
  ['garbage', 'SELECT FROM WHERE', 'parse_error'],
  ['unterminated string', "SELECT 'abc FROM orders", 'parse_error'],
  ['too long', `SELECT ${'a,'.repeat(10_000)}1`, 'too_long'],
];

describe('sql-guard: attacks are rejected', () => {
  it('has at least 40 attack cases', () => {
    expect(attacks.length).toBeGreaterThanOrEqual(40);
  });

  it.each(attacks)('%s', async (_name, sql, code) => {
    const res = await guardSql(sql, policy);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe(code);
  });
});

const allowed: [string, string][] = [
  ['count', 'SELECT count(*) FROM orders'],
  ['trailing semicolon', 'SELECT customer_id FROM customers;'],
  ['select star on a table with no pii', 'SELECT * FROM orders LIMIT 5'],
  ['qualified star on a table with no pii', 'SELECT o.* FROM orders o JOIN order_items i USING (order_id)'],
  ['schema-qualified table', 'SELECT count(*) FROM analytics.orders'],
  [
    'join + group + order + limit',
    `SELECT c.customer_unique_id, sum(p.payment_value) AS revenue
       FROM customers c JOIN orders o ON o.customer_id = c.customer_id
       JOIN order_payments p ON p.order_id = o.order_id
      GROUP BY 1 ORDER BY 2 DESC LIMIT 1`,
  ],
  [
    'cte',
    `WITH m AS (SELECT date_trunc('month', order_purchase_timestamp) AS mo, count(*) AS n FROM orders GROUP BY 1)
     SELECT * FROM m ORDER BY mo`,
  ],
  ['window function', 'SELECT order_id, rank() OVER (ORDER BY order_purchase_timestamp) FROM orders'],
  ['subquery', 'SELECT * FROM (SELECT order_status, count(*) n FROM orders GROUP BY 1) t ORDER BY n DESC'],
  ['filter clause', "SELECT count(*) FILTER (WHERE order_status = 'delivered') FROM orders"],
  ['pg_catalog-qualified aggregate', 'SELECT pg_catalog.count(*) FROM orders'],
  ['comment containing a second statement', 'SELECT 1 /* ; DROP TABLE orders */'],
  ['line comment', 'SELECT 1 -- ; DROP TABLE orders'],
  ['now()', 'SELECT now()'],
  ['current_date', "SELECT order_id FROM orders WHERE order_purchase_timestamp >= current_date - interval '30 days'"],
  ['extract', 'SELECT extract(year FROM order_purchase_timestamp) AS y, count(*) FROM orders GROUP BY 1'],
  ['generate_series with a small range', 'SELECT * FROM generate_series(1, 10) g'],
  ['translation table alias', 'SELECT category.product_category_name_english FROM product_category_name_translation category'],
  ['state (not pii)', 'SELECT DISTINCT customer_state FROM customers'],
  ['non-pii columns of a pii table', 'SELECT customer_unique_id, customer_city FROM customers'],
  ['review score (not pii)', 'SELECT avg(review_score) FROM order_reviews'],
];

describe('sql-guard: legitimate analytics queries pass', () => {
  it.each(allowed)('%s', async (_name, sql) => {
    const res = await guardSql(sql, policy);
    if (!res.ok) throw new Error(`${res.code}: ${res.message}`);
    expect(res.ok).toBe(true);
  });

  it('returns the tables it found and strips the trailing semicolon', async () => {
    const res = await guardSql('SELECT o.order_id FROM orders o JOIN order_items i USING (order_id);', policy);
    expect(res).toEqual({ ok: true, sql: 'SELECT o.order_id FROM orders o JOIN order_items i USING (order_id)', tables: ['order_items', 'orders'] });
  });

  it('gives the model a useful message when a table does not exist', async () => {
    const res = await guardSql('SELECT * FROM customer', policy);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.message).toMatch(/Available tables:.*customers/);
  });
});
