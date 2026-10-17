import { loadModule, parseSync } from 'libpg-query';

/**
 * sql-guard: decides whether LLM-written SQL may run at all.
 *
 * It PARSES the SQL with PostgreSQL's own parser (libpg-query) and walks the syntax tree. A regex or keyword
 * check can be fooled by comments, quoting, CTEs and casing; a parse tree cannot. Rules:
 *   1. exactly one statement, and it is a SELECT (no INSERT/UPDATE/DELETE anywhere, not even inside a CTE)
 *   2. no SELECT ... INTO, no FOR UPDATE / FOR SHARE
 *   3. every table is in the allowlist (nothing from pg_catalog, information_schema, other schemas)
 *   4. no dangerous functions (pg_sleep, dblink, lo_*, set_config, query_to_xml, ...)
 *   5. no PII columns, no wildcard over tables that contain PII columns
 * The database role, the read-only transaction, the timeout and the row limit are further, independent layers.
 */

export type GuardCode =
  | 'empty'
  | 'too_long'
  | 'too_complex'
  | 'parse_error'
  | 'multiple_statements'
  | 'not_select'
  | 'write_in_query'
  | 'select_into'
  | 'locking'
  | 'unknown_table'
  | 'schema_not_allowed'
  | 'forbidden_function'
  | 'huge_argument'
  | 'pii_column'
  | 'pii_wildcard';

export type GuardResult =
  | { ok: true; sql: string; tables: string[] }
  | { ok: false; code: GuardCode; message: string };

export interface GuardPolicy {
  /** lowercase table names that queries may read (all live in the allowed schema) */
  allowedTables: Set<string>;
  /** schema that unqualified or qualified table names must belong to */
  schema?: string;
  /** lowercase column names that must never be referenced */
  piiColumns: Set<string>;
  /** lowercase table names that contain at least one PII column */
  tablesWithPii: Set<string>;
  maxLength?: number;
  maxNodes?: number;
}

const DENY_FUNCTION_PREFIXES = ['pg_', 'lo_', 'dblink', 'has_', 'to_reg', 'txid_', 'current_', 'session_', 'inet_', 'obj_', 'col_', 'shobj_'];
const DENY_FUNCTIONS = new Set([
  'set_config', 'query_to_xml', 'query_to_xml_and_xmlschema', 'query_to_xmlschema', 'table_to_xml',
  'table_to_xml_and_xmlschema', 'table_to_xmlschema', 'cursor_to_xml', 'cursor_to_xmlschema', 'schema_to_xml',
  'schema_to_xml_and_xmlschema', 'schema_to_xmlschema', 'database_to_xml', 'database_to_xml_and_xmlschema',
  'database_to_xmlschema', 'nextval', 'setval', 'currval', 'lastval', 'version', 'format_type', 'pg_sleep',
  'ts_debug', 'binary_upgrade_set_next_pg_enum_oid',
]);
/** functions that can allocate unbounded memory/time when given a huge number */
const SIZE_SENSITIVE = new Set(['repeat', 'lpad', 'rpad', 'generate_series', 'array_fill', 'space']);
const HUGE = 1_000_000;

let ready: Promise<void> | undefined;
export function initGuard(): Promise<void> {
  ready ??= loadModule();
  return ready;
}

type AnyNode = Record<string, unknown>;

function isObj(v: unknown): v is AnyNode {
  return typeof v === 'object' && v !== null;
}

function strVal(n: unknown): string | undefined {
  return isObj(n) && isObj(n.String) && typeof n.String.sval === 'string' ? n.String.sval : undefined;
}

function constInt(n: unknown): number | undefined {
  if (!isObj(n) || !isObj(n.A_Const)) return undefined;
  const c = n.A_Const as AnyNode;
  if (isObj(c.ival) && typeof c.ival.ival === 'number') return c.ival.ival;
  if (isObj(c.fval) && typeof c.fval.fval === 'string') return Number(c.fval.fval);
  return undefined;
}

export async function guardSql(rawSql: string, policy: GuardPolicy): Promise<GuardResult> {
  const schema = policy.schema ?? 'analytics';
  const maxLength = policy.maxLength ?? 12_000;
  const maxNodes = policy.maxNodes ?? 20_000;

  let sql = rawSql.trim();
  if (!sql) return fail('empty', 'The query is empty.');
  if (sql.length > maxLength) return fail('too_long', `The query is longer than ${maxLength} characters.`);
  if (sql.includes('\u0000')) return fail('parse_error', 'The query contains a NUL character.');
  // A trailing semicolon is harmless; anything after it is caught by the parser as a second statement.
  sql = sql.replace(/;+\s*$/, '').trim();
  if (!sql) return fail('empty', 'The query is empty.');

  await initGuard();
  let tree: { stmts?: { stmt?: AnyNode }[] };
  try {
    tree = parseSync(sql) as typeof tree;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return fail('parse_error', `SQL syntax error: ${msg}`);
  }

  const stmts = tree.stmts ?? [];
  if (stmts.length === 0) return fail('empty', 'The query is empty.');
  if (stmts.length > 1) return fail('multiple_statements', 'Only one statement is allowed.');
  const top = stmts[0]!.stmt;
  if (!top || !isObj(top.SelectStmt)) {
    const kind = top ? Object.keys(top)[0] : 'unknown';
    return fail('not_select', `Only SELECT queries are allowed (got ${kind}).`);
  }

  // ---- pass 1: collect CTE names, count nodes -------------------------------
  const cteNames = new Set<string>();
  let nodeCount = 0;
  const pass1 = (n: unknown): void => {
    if (Array.isArray(n)) return n.forEach(pass1);
    if (!isObj(n)) return;
    nodeCount++;
    if (isObj(n.CommonTableExpr) && typeof n.CommonTableExpr.ctename === 'string') {
      cteNames.add(n.CommonTableExpr.ctename.toLowerCase());
    }
    for (const v of Object.values(n)) pass1(v);
  };
  pass1(top);
  if (nodeCount > maxNodes) return fail('too_complex', 'The query is too complex.');
  for (const name of cteNames) {
    // A CTE named like a catalog table could hide a real catalog reference inside its own definition.
    if (name.startsWith('pg_') || name.startsWith('information_schema')) {
      return fail('unknown_table', `The name "${name}" is not allowed for a CTE.`);
    }
  }

  // ---- pass 2: check every node ---------------------------------------------
  const tablesSeen = new Set<string>();
  const aliasToTable = new Map<string, string>();
  let wildcard = false;
  const wholeRowRefs: string[] = [];
  let problem: GuardResult | undefined;

  const visit = (n: unknown): void => {
    if (problem) return;
    if (Array.isArray(n)) return n.forEach(visit);
    if (!isObj(n)) return;

    for (const [key, val] of Object.entries(n)) {
      if (problem) return;

      if (key.endsWith('Stmt') && key !== 'SelectStmt') {
        problem = fail('write_in_query', `Statements of type ${key} are not allowed.`);
        return;
      }

      if (key === 'SelectStmt' && isObj(val)) {
        if (val.intoClause) { problem = fail('select_into', 'SELECT ... INTO is not allowed.'); return; }
        if (Array.isArray(val.lockingClause) && val.lockingClause.length) {
          problem = fail('locking', 'Row locking (FOR UPDATE / FOR SHARE) is not allowed.');
          return;
        }
      }

      if (key === 'RangeVar' && isObj(val)) {
        const rel = String(val.relname ?? '').toLowerCase();
        const sch = typeof val.schemaname === 'string' ? val.schemaname.toLowerCase() : undefined;
        if (val.catalogname) { problem = fail('schema_not_allowed', 'Cross-database references are not allowed.'); return; }
        if (sch && sch !== schema) {
          problem = fail('schema_not_allowed', `Schema "${sch}" is not allowed. Use only the ${schema} tables.`);
          return;
        }
        const isCte = !sch && cteNames.has(rel);
        if (!isCte) {
          if (!policy.allowedTables.has(rel)) {
            problem = fail('unknown_table', `Table "${rel}" does not exist. Available tables: ${[...policy.allowedTables].sort().join(', ')}.`);
            return;
          }
          tablesSeen.add(rel);
          const alias = isObj(val.alias) && typeof val.alias.aliasname === 'string' ? val.alias.aliasname.toLowerCase() : rel;
          aliasToTable.set(alias, rel);
        }
      }

      if (key === 'FuncCall' && isObj(val)) {
        const parts = (Array.isArray(val.funcname) ? val.funcname : []).map(strVal).filter((s): s is string => !!s).map((s) => s.toLowerCase());
        const name = parts.at(-1) ?? '';
        if (parts.length > 1 && !(parts.length === 2 && parts[0] === 'pg_catalog')) {
          problem = fail('forbidden_function', `Schema-qualified function "${parts.join('.')}" is not allowed.`);
          return;
        }
        if (DENY_FUNCTIONS.has(name) || DENY_FUNCTION_PREFIXES.some((p) => name.startsWith(p))) {
          problem = fail('forbidden_function', `Function "${name}" is not allowed.`);
          return;
        }
        if (SIZE_SENSITIVE.has(name) && Array.isArray(val.args)) {
          for (const a of val.args) {
            const c = constInt(a);
            if (c !== undefined && Math.abs(c) > HUGE) {
              problem = fail('huge_argument', `Argument ${c} to ${name}() is too large.`);
              return;
            }
          }
        }
      }

      if (key === 'ColumnRef' && isObj(val) && Array.isArray(val.fields)) {
        const fields = val.fields as unknown[];
        const last = fields.at(-1);
        if (isObj(last) && 'A_Star' in last) {
          wildcard = true;
        } else {
          const col = strVal(last)?.toLowerCase();
          if (col && policy.piiColumns.has(col)) {
            problem = fail('pii_column', `Column "${col}" is restricted (personal data) and cannot be queried.`);
            return;
          }
          if (fields.length === 1 && col) wholeRowRefs.push(col);
        }
      }
    }
    for (const v of Object.values(n)) visit(v);
  };
  visit(top);
  if (problem) return problem;

  if (wildcard) {
    const bad = [...tablesSeen].filter((t) => policy.tablesWithPii.has(t));
    if (bad.length) {
      return fail('pii_wildcard', `SELECT * would expose restricted columns in ${bad.join(', ')}. List the columns you need instead.`);
    }
  }
  for (const ref of wholeRowRefs) {
    const table = aliasToTable.get(ref);
    if (table && policy.tablesWithPii.has(table)) {
      return fail('pii_wildcard', `Referencing the whole row of ${table} would expose restricted columns. List the columns you need instead.`);
    }
  }

  return { ok: true, sql, tables: [...tablesSeen].sort() };
}

function fail(code: GuardCode, message: string): GuardResult {
  return { ok: false, code, message };
}
