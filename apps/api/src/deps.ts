import type pg from 'pg';
import type { Logger } from 'pino';
import type { Config } from '@askdb/shared';
import type { AgentRunner, CatalogProvider, GlossaryStore } from '@askdb/agent';
import type { RunManager } from './runs';

export interface ApiDeps {
  cfg: Config;
  db: pg.Pool;
  runner: AgentRunner;
  runs: RunManager;
  glossary: GlossaryStore;
  catalog: CatalogProvider;
  log: Logger;
  /** provider name shown in the UI, e.g. "mock" or "groq / llama-3.3-70b-versatile" */
  providerLabel: string;
}
