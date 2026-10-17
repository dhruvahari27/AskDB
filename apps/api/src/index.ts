import pg from 'pg';
import { pino } from 'pino';
import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import { getConfig } from '@askdb/shared';
import { createReadOnlyPool } from '@askdb/sql-guard';
import { AgentRunner, PgGlossary, cachedCatalogProvider, createProvider } from '@askdb/agent';
import { createApp } from './app';
import { RunManager } from './runs';

const cfg = getConfig();
const log = pino({ level: process.env.LOG_LEVEL ?? 'info', redact: ['req.headers.cookie', 'req.headers.authorization'] });

if (cfg.NODE_ENV === 'production' && (cfg.JWT_SECRET.startsWith('dev-only') || cfg.JWT_SECRET.startsWith('change-me') || cfg.JWT_SECRET.length < 32)) {
  log.fatal('JWT_SECRET is missing, a placeholder, or shorter than 32 characters. Refusing to start in production.');
  process.exit(1);
}

const db = new pg.Pool({ connectionString: cfg.APP_DATABASE_URL, max: 10 });
const warehouse = createReadOnlyPool(cfg.WAREHOUSE_READONLY_URL, 6);

try {
  await db.query('SELECT 1 FROM users LIMIT 1');
  await warehouse.query('SELECT 1 FROM analytics.orders LIMIT 1');
} catch (e) {
  log.fatal(
    { err: (e as Error).message },
    'Cannot reach the databases (or they are not set up). Start Postgres (`npm run db:embedded`, or use your own) and run `npm run setup`.',
  );
  process.exit(1);
}

const checkpointer = PostgresSaver.fromConnString(cfg.APP_DATABASE_URL, { schema: 'langgraph' });
await checkpointer.setup();

const llm = await createProvider(cfg, { cache: 'auto' });
const catalog = cachedCatalogProvider(warehouse);
const glossary = new PgGlossary(db);
const runner = new AgentRunner({
  llm,
  warehouse,
  catalog,
  glossary,
  checkpointer,
  limits: { timeoutMs: cfg.STATEMENT_TIMEOUT_MS, maxRows: cfg.MAX_RESULT_ROWS, maxPlanCost: cfg.MAX_PLAN_COST },
});

const providerLabel = llm.name === 'mock' ? 'mock (offline demo)' : `${llm.name} / ${llm.model}`;
const runs = new RunManager();
const app = createApp({ cfg, db, runner, runs, glossary, catalog, log, providerLabel });

const server = app.listen(cfg.PORT, () => {
  log.info(`AskDB API listening on http://localhost:${cfg.PORT}  (LLM: ${providerLabel})`);
  if (llm.name === 'mock') log.warn('LLM_PROVIDER=mock: only a few demo questions are understood. Set LLM_PROVIDER=groq or gemini in .env for real use.');
});

const shutdown = (signal: string) => {
  log.info(`${signal} received, shutting down`);
  server.close(() => {
    runs.close();
    Promise.allSettled([db.end(), warehouse.end()]).then(() => process.exit(0));
  });
  setTimeout(() => process.exit(0), 5000).unref();
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
