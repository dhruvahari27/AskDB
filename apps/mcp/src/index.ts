import pg from 'pg';
import { MemorySaver } from '@langchain/langgraph';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { getConfig, sanitizeForDb } from '@askdb/shared';
import { createReadOnlyPool } from '@askdb/sql-guard';
import { AgentRunner, MemoryGlossary, PgGlossary, cachedCatalogProvider, createProvider, type GlossaryStore } from '@askdb/agent';
import { createAskDbServer } from './server';

// stdout is the protocol channel: everything human-readable goes to stderr.
const log = (...a: unknown[]) => console.error('[askdb-mcp]', ...a);

const cfg = getConfig();
const warehouse = createReadOnlyPool(cfg.WAREHOUSE_READONLY_URL, 4);
try {
  await warehouse.query('SELECT 1 FROM analytics.orders LIMIT 1');
} catch (e) {
  log('Cannot reach the warehouse. Start Postgres (`npm run db:embedded`) and run `npm run setup`.', (e as Error).message);
  process.exit(1);
}

// Approved glossary terms are shared with the web app when its database is reachable; otherwise run without them.
let glossary: GlossaryStore = new MemoryGlossary();
let appDb: pg.Pool | undefined;
try {
  appDb = new pg.Pool({ connectionString: cfg.APP_DATABASE_URL, max: 2, connectionTimeoutMillis: 2000 });
  const origQuery = appDb.query.bind(appDb);
  appDb.query = ((text: any, params?: any, cb?: any) => {
    if (Array.isArray(params)) params = params.map(sanitizeForDb);
    return origQuery(text, params, cb);
  }) as typeof appDb.query;
  await appDb.query('SELECT 1 FROM glossary_terms LIMIT 1');
  glossary = new PgGlossary(appDb);
} catch {
  log('App database not available: running without the shared glossary.');
}

const llm = await createProvider(cfg, { cache: 'auto' });
const catalog = cachedCatalogProvider(warehouse);
const runner = new AgentRunner({
  llm,
  warehouse,
  catalog,
  glossary,
  // In-memory on purpose: a paused question lives as long as this MCP process does, which is the lifetime of the client session.
  checkpointer: new MemorySaver(),
  limits: { timeoutMs: cfg.STATEMENT_TIMEOUT_MS, maxRows: cfg.MAX_RESULT_ROWS, maxPlanCost: cfg.MAX_PLAN_COST },
});

const server = createAskDbServer({ runner, catalog });
await server.connect(new StdioServerTransport());
log(`ready (LLM: ${llm.name}/${llm.model})`);
const stop = () => void Promise.allSettled([warehouse.end(), appDb?.end()]).then(() => process.exit(0));
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
