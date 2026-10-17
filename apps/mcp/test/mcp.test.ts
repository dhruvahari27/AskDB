import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { cachedCatalogProvider } from '@askdb/agent';
import { makeRunner, warehouseAvailable } from '../../../packages/agent/test/helpers';
import { createAskDbServer } from '../src/server';

const available = await warehouseAvailable();

describe.skipIf(!available)('MCP server (needs the warehouse)', () => {
  async function connect() {
    const { runner, pool } = makeRunner();
    const server = createAskDbServer({ runner, catalog: cachedCatalogProvider(pool) });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(b);
    const client = new Client({ name: 'test', version: '1' });
    await client.connect(a);
    const call = async (name: string, args: Record<string, unknown>) => {
      const r = await client.callTool({ name, arguments: args });
      const t = (r.content as { type: string; text: string }[])[0]!.text;
      return { isError: Boolean(r.isError), json: JSON.parse(t) };
    };
    return { client, call, pool };
  }

  it('lists its three tools and hides personal-data columns', async () => {
    const { client, call, pool } = await connect();
    const tools = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(tools).toEqual(['answer_clarification', 'ask_database', 'describe_schema']);
    const s = await call('describe_schema', {});
    const cols = s.json.tables.flatMap((t: any) => t.columns.map((c: any) => c.name));
    expect(cols).not.toContain('customer_zip_code_prefix');
    expect(cols).toContain('customer_state');
    await client.close();
    await pool.end();
  });

  it('answers a clear question directly', async () => {
    const { client, call, pool } = await connect();
    const r = await call('ask_database', { question: 'What is the order status breakdown?' });
    expect(r.json.status).toBe('answered');
    expect(r.json.result.rows.length).toBeGreaterThan(1);
    await client.close();
    await pool.end();
  });

  it('hands an ambiguous question back to the calling agent, then finishes it', async () => {
    const { client, call, pool } = await connect();
    const first = await call('ask_database', { question: 'Who is our best customer?' });
    expect(first.json.status).toBe('needs_clarification');
    expect(first.json.options.length).toBeGreaterThanOrEqual(2);
    expect(first.json.options[0].preview.rows.length).toBeGreaterThan(0);

    const bad = await call('answer_clarification', { runId: first.json.runId, optionId: 'nope' });
    expect(bad.isError).toBe(true);
    const both = await call('answer_clarification', { runId: first.json.runId, optionId: first.json.options[0].optionId, freeText: 'x y' });
    expect(both.isError).toBe(true);

    const done = await call('answer_clarification', { runId: first.json.runId, optionId: first.json.options[1].optionId });
    expect(done.json.status).toBe('answered');
    expect(done.json.howDecided).toBe('user-clarified');

    const again = await call('answer_clarification', { runId: first.json.runId, optionId: first.json.options[1].optionId });
    expect(again.isError).toBe(true);
    await client.close();
    await pool.end();
  });
});
