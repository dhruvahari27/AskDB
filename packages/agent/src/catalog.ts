import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type pg from 'pg';
import { parse as parseYaml } from 'yaml';
import { repoRoot } from '@askdb/shared';
import type { GuardPolicy } from '@askdb/sql-guard';

export interface ColumnInfo {
  name: string;
  type: string;
  description: string;
  pii: boolean;
  isPk: boolean;
  fk?: { table: string; column: string };
}

export interface TableInfo {
  name: string;
  description: string;
  columns: ColumnInfo[];
  rowEstimate: number;
}

export interface SchemaCatalog {
  schema: string;
  tables: TableInfo[];
  /**
   * The latest order date in the data. Relative dates ("last month") are computed from this, not from today:
   * a dataset that ends in 2018 has no "last month" in 2026.
   */
  asOf: string;
}

export type CatalogProvider = () => Promise<SchemaCatalog>;

interface DocsFile {
  tables?: Record<string, { description?: string; columns?: Record<string, { description?: string; pii?: boolean }> }>;
}

export function loadSchemaDocs(path = resolve(repoRoot, 'warehouse/schema_docs.yaml')): DocsFile {
  if (!existsSync(path)) return {};
  return (parseYaml(readFileSync(path, 'utf8')) as DocsFile) ?? {};
}

export async function loadCatalog(pool: pg.Pool, docs: DocsFile = loadSchemaDocs(), schema = 'analytics'): Promise<SchemaCatalog> {
  const cols = await pool.query<{ table_name: string; column_name: string; data_type: string }>(
    `SELECT table_name, column_name, data_type
       FROM information_schema.columns
      WHERE table_schema = $1
      ORDER BY table_name, ordinal_position`,
    [schema],
  );
  const pks = await pool.query<{ table_name: string; column_name: string }>(
    `SELECT tc.table_name, kcu.column_name
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu
         ON kcu.constraint_name = tc.constraint_name AND kcu.table_schema = tc.table_schema
      WHERE tc.constraint_type = 'PRIMARY KEY' AND tc.table_schema = $1`,
    [schema],
  );
  const fks = await pool.query<{ table_name: string; column_name: string; ftable: string; fcolumn: string }>(
    `SELECT cl.relname AS table_name, a.attname AS column_name, fcl.relname AS ftable, fa.attname AS fcolumn
       FROM pg_constraint c
       JOIN pg_class cl ON cl.oid = c.conrelid
       JOIN pg_namespace n ON n.oid = cl.relnamespace
       JOIN pg_class fcl ON fcl.oid = c.confrelid
       JOIN LATERAL unnest(c.conkey, c.confkey) AS k(attnum, fattnum) ON true
       JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
       JOIN pg_attribute fa ON fa.attrelid = c.confrelid AND fa.attnum = k.fattnum
      WHERE c.contype = 'f' AND n.nspname = $1`,
    [schema],
  );
  const est = await pool.query<{ relname: string; n: number }>(
    `SELECT c.relname, c.reltuples::bigint AS n FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND c.relkind = 'r'`,
    [schema],
  );

  const pkSet = new Set(pks.rows.map((r) => `${r.table_name}.${r.column_name}`));
  const fkMap = new Map(fks.rows.map((r) => [`${r.table_name}.${r.column_name}`, { table: r.ftable, column: r.fcolumn }]));
  const rowMap = new Map(est.rows.map((r) => [r.relname, Number(r.n)]));

  const byTable = new Map<string, TableInfo>();
  for (const r of cols.rows) {
    let t = byTable.get(r.table_name);
    if (!t) {
      t = { name: r.table_name, description: docs.tables?.[r.table_name]?.description?.trim().replace(/\s+/g, ' ') ?? '', columns: [], rowEstimate: rowMap.get(r.table_name) ?? 0 };
      byTable.set(r.table_name, t);
    }
    const d = docs.tables?.[r.table_name]?.columns?.[r.column_name];
    t.columns.push({
      name: r.column_name,
      type: r.data_type,
      description: d?.description ?? '',
      pii: d?.pii === true,
      isPk: pkSet.has(`${r.table_name}.${r.column_name}`),
      fk: fkMap.get(`${r.table_name}.${r.column_name}`),
    });
  }

  const asOfRow = await pool.query<{ d: string | null }>('SELECT max(order_purchase_timestamp)::date::text AS d FROM analytics.orders');
  return { schema, tables: [...byTable.values()], asOf: asOfRow.rows[0]?.d ?? new Date().toISOString().slice(0, 10) };
}

/** Cache the catalog for a few minutes so each question does not re-read information_schema. */
export function cachedCatalogProvider(pool: pg.Pool, ttlMs = 5 * 60_000): CatalogProvider {
  let value: SchemaCatalog | undefined;
  let at = 0;
  let inflight: Promise<SchemaCatalog> | undefined;
  return async () => {
    if (value && Date.now() - at < ttlMs) return value;
    inflight ??= loadCatalog(pool)
      .then((c) => {
        value = c;
        at = Date.now();
        return c;
      })
      .finally(() => {
        inflight = undefined;
      });
    return inflight;
  };
}

export function policyFromCatalog(catalog: SchemaCatalog): GuardPolicy {
  const piiColumns = new Set<string>();
  const tablesWithPii = new Set<string>();
  for (const t of catalog.tables) {
    for (const c of t.columns) {
      if (c.pii) {
        piiColumns.add(c.name.toLowerCase());
        tablesWithPii.add(t.name.toLowerCase());
      }
    }
  }
  return { allowedTables: new Set(catalog.tables.map((t) => t.name.toLowerCase())), schema: catalog.schema, piiColumns, tablesWithPii };
}
