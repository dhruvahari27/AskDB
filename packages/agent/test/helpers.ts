import pg from 'pg';
import { MemorySaver } from '@langchain/langgraph';
import { getConfig } from '@askdb/shared';
import { createReadOnlyPool } from '@askdb/sql-guard';
import { AgentRunner, MemoryGlossary, MockProvider, cachedCatalogProvider, type AgentDeps, type LlmProvider, type LlmRequest, type LlmResponse } from '../src';

const cfg = getConfig();

export async function warehouseAvailable(): Promise<boolean> {
  try {
    const c = new pg.Client({ connectionString: cfg.WAREHOUSE_READONLY_URL, connectionTimeoutMillis: 1500 });
    await c.connect();
    const { rows } = await c.query("SELECT to_regclass('analytics.orders') AS t");
    await c.end();
    return Boolean(rows[0].t);
  } catch {
    return false;
  }
}

export function makeRunner(llm: LlmProvider = new MockProvider(), glossary = new MemoryGlossary(), over: Partial<AgentDeps> = {}) {
  const pool = createReadOnlyPool(cfg.WAREHOUSE_READONLY_URL, 4);
  const runner = new AgentRunner({
    llm,
    warehouse: pool,
    catalog: cachedCatalogProvider(pool),
    glossary,
    checkpointer: new MemorySaver(),
    limits: { timeoutMs: 5000, maxRows: 500, maxPlanCost: 5_000_000 },
    ...over,
  });
  return { runner, pool, glossary };
}

/** Provider that replays scripted replies, to test failure handling. */
export class ScriptedProvider implements LlmProvider {
  readonly name = 'scripted';
  readonly model = 'scripted';
  calls: LlmRequest[] = [];
  constructor(private replies: (string | ((req: LlmRequest) => string))[]) {}
  async complete(req: LlmRequest): Promise<LlmResponse> {
    this.calls.push(req);
    const r = this.replies.shift();
    if (r === undefined) throw new Error('ScriptedProvider ran out of replies');
    const text = typeof r === 'function' ? r(req) : r;
    return { text, inputTokens: 10, outputTokens: 10 };
  }
}
