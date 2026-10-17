import pg from 'pg';
import { getConfig } from '@askdb/shared';
import { createReadOnlyPool } from '@askdb/sql-guard';
import { Harness } from './harness';
import { loadCases } from './dataset';

/**
 * Lints the eval dataset: schema, duplicate ids, and that every gold query parses, passes the guard and runs.
 * A gold query that returns zero rows is reported as a warning (it would make accuracy meaningless for that case).
 */
const cfg = getConfig();
const cases = loadCases();
const pool = createReadOnlyPool(cfg.WAREHOUSE_READONLY_URL, 2);
const h = new Harness({
  llm: null as never,
  warehouse: pool as pg.Pool,
  limits: { timeoutMs: cfg.STATEMENT_TIMEOUT_MS, maxRows: cfg.MAX_RESULT_ROWS, maxPlanCost: cfg.MAX_PLAN_COST },
  useDefaultGlossary: false,
});

let bad = 0;
for (const c of cases) {
  try {
    const rows = await h.goldRows(c);
    if (rows.length === 0) {
      console.warn(`WARN ${c.id}: gold query returns no rows`);
    }
  } catch (e) {
    bad++;
    console.error(`FAIL ${c.id}: ${(e as Error).message}`);
  }
}
const amb = cases.filter((c) => c.isAmbiguous).length;
console.log(`${cases.length} cases (${amb} ambiguous, ${cases.length - amb} clear, ${cases.filter((c) => c.split === 'test').length} in the test split): ${bad === 0 ? 'all gold queries run' : `${bad} failing`}`);
await pool.end();
process.exit(bad ? 1 : 0);
