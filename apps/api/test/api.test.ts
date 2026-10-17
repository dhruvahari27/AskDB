import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import pg from 'pg';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import { getConfig, type Config, type RunEvent } from '@askdb/shared';
import { createReadOnlyPool } from '@askdb/sql-guard';
import { AgentRunner, MockProvider, PgGlossary, cachedCatalogProvider } from '@askdb/agent';
import { createApp } from '../src/app';
import { RunManager } from '../src/runs';

const cfg0 = getConfig();

async function reachable(): Promise<boolean> {
  try {
    const a = new pg.Client({ connectionString: cfg0.APP_DATABASE_URL, connectionTimeoutMillis: 1500 });
    await a.connect();
    const r = await a.query("SELECT to_regclass('public.users') AS t");
    await a.end();
    const w = new pg.Client({ connectionString: cfg0.WAREHOUSE_READONLY_URL, connectionTimeoutMillis: 1500 });
    await w.connect();
    await w.end();
    return Boolean(r.rows[0].t);
  } catch {
    return false;
  }
}
const available = await reachable();

interface Instance {
  base: string;
  server: Server;
  close(): Promise<void>;
}

const openResources: { end(): Promise<void> }[] = [];
async function boot(cfgOver: Partial<Config> = {}): Promise<Instance> {
  const cfg = { ...cfg0, JWT_SECRET: 'test-secret-test-secret', ...cfgOver } as Config;
  const db = new pg.Pool({ connectionString: cfg.APP_DATABASE_URL, max: 5 });
  const warehouse = createReadOnlyPool(cfg.WAREHOUSE_READONLY_URL, 4);
  const checkpointer = PostgresSaver.fromConnString(cfg.APP_DATABASE_URL, { schema: 'langgraph' });
  await checkpointer.setup();
  const catalog = cachedCatalogProvider(warehouse);
  const glossary = new PgGlossary(db);
  const runner = new AgentRunner({
    llm: new MockProvider(),
    warehouse,
    catalog,
    glossary,
    checkpointer,
    limits: { timeoutMs: 5000, maxRows: 500, maxPlanCost: 5_000_000 },
  });
  const runs = new RunManager();
  const app = createApp({ cfg, db, runner, runs, glossary, catalog, log: pino({ level: 'silent' }), providerLabel: 'mock' });
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const close = async () => {
    await new Promise((r) => server.close(r));
    runs.close();
    await Promise.allSettled([db.end(), warehouse.end(), checkpointer.end()]);
  };
  openResources.push({ end: close });
  return { base, server, close };
}

class Client {
  cookie = '';
  constructor(public base: string) {}
  async req(path: string, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}) {
    const res = await fetch(`${this.base}/api${path}`, {
      method: init.method ?? (init.body ? 'POST' : 'GET'),
      headers: { 'content-type': 'application/json', ...(this.cookie ? { cookie: this.cookie } : {}), ...init.headers },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    });
    const set = res.headers.get('set-cookie');
    if (set) this.cookie = set.split(';')[0]!;
    const text = await res.text();
    let json: any = undefined;
    try {
      json = JSON.parse(text);
    } catch {
      /* not json */
    }
    return { status: res.status, json };
  }
  /** Read the SSE stream until the server closes it. */
  async stream(runId: string, after?: number): Promise<(RunEvent & { i: number })[]> {
    const res = await fetch(`${this.base}/api/runs/${runId}/stream${after === undefined ? '' : `?after=${after}`}`, { headers: { cookie: this.cookie } });
    if (res.status !== 200) throw new Error(`stream status ${res.status}`);
    const text = await res.text();
    return text
      .split('\n\n')
      .map((b) => b.split('\n').find((l) => l.startsWith('data: ')))
      .filter((l): l is string => !!l)
      .map((l) => JSON.parse(l.slice(6)));
  }
}

const stamp = Date.now();
const emailA = `admin-${stamp}@test.dev`;
const emailB = `analyst-${stamp}@test.dev`;
const pw = 'correct horse battery';

describe.skipIf(!available)('API (needs both databases: run `npm run db:embedded` and `npm run setup`)', () => {
  let inst: Instance;
  let A: Client;
  let B: Client;
  let adminDb: pg.Pool;

  beforeAll(async () => {
    inst = await boot();
    A = new Client(inst.base);
    B = new Client(inst.base);
    adminDb = new pg.Pool({ connectionString: cfg0.APP_DATABASE_URL, max: 2 });
    await A.req('/auth/register', { body: { email: emailA, password: pw } });
    await adminDb.query("UPDATE users SET role = 'admin' WHERE email = $1", [emailA]);
    await B.req('/auth/register', { body: { email: emailB, password: pw } });
  });

  afterAll(async () => {
    await adminDb.query('DELETE FROM users WHERE email = ANY($1)', [[emailA, emailB]]);
    await adminDb.query("DELETE FROM glossary_terms WHERE source = 'clarification' AND created_by IS NULL");
    await adminDb.end();
    await Promise.all(openResources.map((r) => r.end()));
  });

  async function newConversation(c: Client) {
    const r = await c.req('/conversations', { body: {} });
    expect(r.status).toBe(201);
    return r.json.conversation.id as string;
  }

  it('requires sign-in', async () => {
    const anon = new Client(inst.base);
    expect((await anon.req('/conversations')).status).toBe(401);
    expect((await anon.req('/auth/me')).status).toBe(401);
    expect((await anon.req('/schema')).status).toBe(401);
  });

  it('validates registration and login', async () => {
    const anon = new Client(inst.base);
    expect((await anon.req('/auth/register', { body: { email: 'not-an-email', password: pw } })).status).toBe(400);
    expect((await anon.req('/auth/register', { body: { email: `x${stamp}@test.dev`, password: 'short' } })).status).toBe(400);
    expect((await anon.req('/auth/register', { body: { email: emailB, password: pw } })).status).toBe(409);
    expect((await anon.req('/auth/login', { body: { email: emailB, password: 'wrong password!' } })).status).toBe(401);
    const ok = await anon.req('/auth/login', { body: { email: emailB, password: pw } });
    expect(ok.status).toBe(200);
    expect(ok.json.user.role).toBe('analyst');
    expect(ok.json.user.password_hash).toBeUndefined();
  });

  it('keeps conversations private to their owner', async () => {
    const id = await newConversation(A);
    expect((await B.req(`/conversations/${id}`)).status).toBe(404);
    expect((await B.req(`/conversations/${id}`, { method: 'DELETE' })).status).toBe(404);
    expect((await B.req(`/conversations/${id}/ask`, { body: { question: 'How many orders are there?' } })).status).toBe(404);
    expect((await A.req('/conversations/not-a-uuid')).status).toBe(404);
    expect((await A.req(`/conversations/${id}`)).status).toBe(200);
  });

  it('answers a clear question and saves the whole exchange', async () => {
    const id = await newConversation(A);
    const ask = await A.req(`/conversations/${id}/ask`, { body: { question: 'What is the order status breakdown?' } });
    expect(ask.status).toBe(202);
    const events = await A.stream(ask.json.runId);
    expect(events.some((e) => e.type === 'step' && e.node === 'draft')).toBe(true);
    const result = events.find((e) => e.type === 'result') as Extract<RunEvent, { type: 'result' }>;
    expect(result.result.result.rowCount).toBeGreaterThan(3);
    expect(events.at(-1)).toMatchObject({ type: 'done', status: 'complete' });

    const conv = await A.req(`/conversations/${id}`);
    const assistant = conv.json.messages.find((m: any) => m.role === 'assistant');
    expect(assistant.status).toBe('complete');
    expect(assistant.result.kind).toBe('answer');
    expect(assistant.result.trace.length).toBeGreaterThan(3);
    expect(conv.json.conversation.title).toBe('What is the order status breakdown?');
  });

  it('streams can be resumed with ?after= and rebuilt from the database', async () => {
    const id = await newConversation(A);
    const ask = await A.req(`/conversations/${id}/ask`, { body: { question: 'What is the order status breakdown?' } });
    const all = await A.stream(ask.json.runId);
    const tail = await A.stream(ask.json.runId, all.length - 3);
    expect(tail.map((e) => e.i)).toEqual(all.slice(-2).map((e) => e.i));

    // a fresh server (no in-memory events) still answers the stream from saved data
    const second = await boot();
    const A2 = new Client(second.base);
    A2.cookie = A.cookie;
    const replay = await A2.stream(ask.json.runId);
    expect(replay.map((e) => e.type)).toEqual(['result', 'done']);
  });

  it('asks only when readings differ, learns the choice, and an approved definition removes the question', async () => {
    const id = await newConversation(A);
    const question = `Who is our best customer? (${stamp})`;
    const ask = await A.req(`/conversations/${id}/ask`, { body: { question } });
    const first = await A.stream(ask.json.runId);
    const needed = first.find((e) => e.type === 'clarification_needed') as Extract<RunEvent, { type: 'clarification_needed' }>;
    expect(needed.clarification.options.length).toBeGreaterThanOrEqual(2);
    expect(first.at(-1)).toMatchObject({ type: 'done', status: 'awaiting_clarification' });

    let conv = await A.req(`/conversations/${id}`);
    expect(conv.json.messages.at(-1).status).toBe('awaiting_clarification');
    expect(conv.json.messages.at(-1).result.kind).toBe('clarification');

    // wrong option, wrong user, then the right answer
    expect((await A.req(`/runs/${ask.json.runId}/clarify`, { body: { optionId: 'nope' } })).status).toBe(400);
    expect((await B.req(`/runs/${ask.json.runId}/clarify`, { body: { optionId: 'c1' } })).status).toBe(404);
    expect((await A.req(`/runs/${ask.json.runId}/clarify`, { body: {} })).status).toBe(400);
    const pick = needed.clarification.options[0]!;
    const clar = await A.req(`/runs/${ask.json.runId}/clarify`, { body: { optionId: pick.id } });
    expect(clar.status).toBe(202);
    const second = await A.stream(ask.json.runId, first.at(-1)!.i);
    expect(second.find((e) => e.type === 'result')).toBeTruthy();
    expect(second.at(-1)).toMatchObject({ type: 'done', status: 'complete' });

    // a second answer to the same question is refused
    expect((await A.req(`/runs/${ask.json.runId}/clarify`, { body: { optionId: pick.id } })).status).toBe(409);

    conv = await A.req(`/conversations/${id}`);
    expect(conv.json.messages.at(-1).status).toBe('complete');

    // the choice became a PROPOSED term; only an admin can approve it
    const proposed = (await A.req('/glossary?status=proposed')).json.terms.find((t: any) => t.term === 'best customer' && t.definition === pick.meaning);
    expect(proposed).toBeTruthy();
    expect((await B.req(`/glossary/${proposed.id}`, { method: 'PATCH', body: { status: 'approved' } })).status).toBe(403);
    expect((await A.req(`/glossary/${proposed.id}`, { method: 'PATCH', body: { status: 'approved' } })).status).toBe(200);

    // with the approved term, the same kind of question is answered straight away
    const ask2 = await A.req(`/conversations/${id}/ask`, { body: { question: 'Who is our best customer?' } });
    const third = await A.stream(ask2.json.runId);
    expect(third.some((e) => e.type === 'clarification_needed')).toBe(false);
    expect(third.some((e) => e.type === 'assumption' && /best customer = /.test(e.text))).toBe(true);
    expect(third.at(-1)).toMatchObject({ status: 'complete' });

    await A.req(`/glossary/${proposed.id}`, { method: 'DELETE' });
  });

  it('a paused clarification survives a full server restart (checkpoint in Postgres)', async () => {
    const id = await newConversation(A);
    const ask = await A.req(`/conversations/${id}/ask`, { body: { question: 'Who is our best customer?' } });
    const first = await A.stream(ask.json.runId);
    const needed = first.find((e) => e.type === 'clarification_needed') as Extract<RunEvent, { type: 'clarification_needed' }>;
    expect(needed).toBeTruthy();

    await inst.close(); // the first server goes away completely
    inst = await boot(); // a brand-new process-equivalent: new runner, new checkpointer, empty RunManager
    A.base = inst.base;
    B.base = inst.base;

    const clar = await A.req(`/runs/${ask.json.runId}/clarify`, { body: { optionId: needed.clarification.options[1]!.id } });
    expect(clar.status).toBe(202);
    const events = await A.stream(ask.json.runId);
    expect(events.find((e) => e.type === 'result')).toBeTruthy();
    expect(events.at(-1)).toMatchObject({ status: 'complete' });
  });

  it('accepts a free-text clarification', async () => {
    const id = await newConversation(A);
    const ask = await A.req(`/conversations/${id}/ask`, { body: { question: 'How many customers do we have?' } });
    await A.stream(ask.json.runId);
    const clar = await A.req(`/runs/${ask.json.runId}/clarify`, { body: { freeText: 'I mean unique people, not customer ids' } });
    expect(clar.status).toBe(202);
    const events = await A.stream(ask.json.runId);
    const res = events.find((e) => e.type === 'result') as Extract<RunEvent, { type: 'result' }>;
    expect(res.result.path).toBe('user-free-text');
    // A fresh attach after a clarification must see only the resumed segment, or the browser would stop at the old `done`.
    expect(events.filter((e) => e.type === 'done')).toHaveLength(1);
    expect(events.some((e) => e.type === 'clarification_needed')).toBe(false);
  });

  it('validates questions and enforces the daily token budget', async () => {
    const id = await newConversation(A);
    expect((await A.req(`/conversations/${id}/ask`, { body: { question: 'hi' } })).status).toBe(400);
    expect((await A.req(`/conversations/${id}/ask`, { body: {} })).status).toBe(400);

    const tiny = await boot({ DAILY_TOKEN_BUDGET: 1 });
    const T = new Client(tiny.base);
    T.cookie = A.cookie;
    const r = await T.req(`/conversations/${id}/ask`, { body: { question: 'How many orders are there?' } });
    expect(r.status).toBe(429);
    expect(r.json.error).toMatch(/budget/i);
  });

  it('stores feedback and exposes corrections to admins only', async () => {
    const id = await newConversation(A);
    const ask = await A.req(`/conversations/${id}/ask`, { body: { question: 'What is the order status breakdown?' } });
    await A.stream(ask.json.runId);
    const msg = (await A.req(`/conversations/${id}`)).json.messages.find((m: any) => m.role === 'assistant');
    expect((await A.req(`/messages/${msg.id}/feedback`, { body: { rating: 2 } })).status).toBe(400);
    const fb = await A.req(`/messages/${msg.id}/feedback`, { body: { rating: -1, correctedSql: 'SELECT order_status, count(*) FROM orders GROUP BY 1', note: 'wrong' } });
    expect(fb.status).toBe(200);
    expect((await B.req(`/messages/${msg.id}/feedback`, { body: { rating: 1 } })).status).toBe(404);
    expect((await B.req('/feedback/corrections')).status).toBe(403);
    const list = await A.req('/feedback/corrections');
    expect(list.json.corrections.some((c: any) => c.correctedSql?.includes('GROUP BY'))).toBe(true);
    const again = (await A.req(`/conversations/${id}`)).json.messages.find((m: any) => m.role === 'assistant');
    expect(again.feedbackRating).toBe(-1);
  });

  it('serves the schema (with PII tagged), stats and health', async () => {
    const schema = await A.req('/schema');
    expect(schema.json.tables.length).toBe(8);
    const customers = schema.json.tables.find((t: any) => t.name === 'customers');
    expect(customers.columns.find((c: any) => c.name === 'customer_zip_code_prefix').pii).toBe(true);
    expect(schema.json.asOf).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const stats = await A.req('/stats');
    expect(stats.json.totals.runs).toBeGreaterThan(0);
    expect(stats.json.perDay).toHaveLength(7);
    const health = await new Client(inst.base).req('/health');
    expect(health.json.status).toBe('ok');
  });

  it('never leaks internals: unknown routes and bad JSON get clean errors', async () => {
    const r = await fetch(`${inst.base}/api/nope`, { headers: { cookie: A.cookie } });
    expect(r.status).toBe(404);
    const bad = await fetch(`${inst.base}/api/conversations`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: A.cookie }, body: '{oops' });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: 'Request body is not valid JSON' });
  });
});
