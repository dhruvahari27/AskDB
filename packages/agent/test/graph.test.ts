import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import type { RunEvent } from '@askdb/shared';
import { MemoryGlossary } from '../src';
import { ScriptedProvider, makeRunner, warehouseAvailable } from './helpers';

const available = await warehouseAvailable();
const pools: { end(): Promise<void> }[] = [];
afterAll(async () => {
  await Promise.all(pools.map((p) => p.end()));
});

function setup(...args: Parameters<typeof makeRunner>) {
  const m = makeRunner(...args);
  pools.push(m.pool);
  return m;
}
const collect = () => {
  const events: RunEvent[] = [];
  return { events, on: (e: RunEvent) => void events.push(e) };
};

describe.skipIf(!available)('agent graph (needs the warehouse: run `npm run setup`)', () => {
  it('answers a clear question in one go, without asking', async () => {
    const { runner } = setup();
    const ev = collect();
    const out = await runner.start({ runId: randomUUID(), question: 'What is the order status breakdown?', mode: 'execution' }, ev.on);
    expect(out.status).toBe('complete');
    if (out.status !== 'complete') return;
    expect(out.answer.path).toBe('single-reading');
    expect(out.answer.result.rowCount).toBeGreaterThan(3);
    expect(out.answer.chart.type).toBe('bar');
    expect(ev.events.some((e) => e.type === 'clarification_needed')).toBe(false);
    expect(ev.events.at(-1)).toMatchObject({ type: 'done', status: 'complete' });
  });

  it('pauses on a question whose readings return different results, then resumes with the chosen reading', async () => {
    const { runner } = setup();
    const runId = randomUUID();
    const ev = collect();
    const first = await runner.start({ runId, question: 'Who is our best customer?', mode: 'execution' }, ev.on);
    expect(first.status).toBe('awaiting_clarification');
    if (first.status !== 'awaiting_clarification') return;
    const c = first.clarification;
    expect(c.options.length).toBeGreaterThanOrEqual(2);
    expect(c.options.every((o) => o.preview && o.preview.rows.length > 0)).toBe(true);
    // each option previews a genuinely different answer
    const heads = new Set(c.options.map((o) => JSON.stringify(o.preview!.rows[0])));
    expect(heads.size).toBe(c.options.length);
    expect(c.term).toBe('best customer');
    expect(await runner.pendingClarification(runId)).not.toBeNull();

    const pick = c.options[1]!;
    const second = await runner.resume(runId, { optionId: pick.id }, ev.on);
    expect(second.status).toBe('complete');
    if (second.status !== 'complete') return;
    expect(second.answer.path).toBe('user-clarified');
    expect(second.answer.meaning).toBe(pick.meaning);
    expect(await runner.pendingClarification(runId)).toBeNull();
  });

  it('saves the user choice as a PROPOSED glossary term, which is not used until approved', async () => {
    const glossary = new MemoryGlossary();
    const { runner } = setup(undefined, glossary);
    const runId = randomUUID();
    const first = await runner.start({ runId, question: 'Who is our best customer?', mode: 'execution' });
    if (first.status !== 'awaiting_clarification') throw new Error('expected a question');
    const pick = first.clarification.options[0]!;
    await runner.resume(runId, { optionId: pick.id });
    expect(glossary.terms).toHaveLength(1);
    expect(glossary.terms[0]).toMatchObject({ term: 'best customer', definition: pick.meaning, status: 'proposed' });

    // still asks, because the term is only proposed
    const again = await runner.start({ runId: randomUUID(), question: 'Who is our best customer?', mode: 'execution' });
    expect(again.status).toBe('awaiting_clarification');

    // once approved, the question is answered directly and the definition is shown as an assumption
    glossary.terms[0]!.status = 'approved';
    const ev = collect();
    const third = await runner.start({ runId: randomUUID(), question: 'Who is our best customer?', mode: 'execution' }, ev.on);
    expect(third.status).toBe('complete');
    expect(ev.events.some((e) => e.type === 'assumption' && /best customer = /.test(e.text))).toBe(true);
  });

  it('does not ask when the readings return the same rows', async () => {
    const sameRows = JSON.stringify({
      ambiguous_term: 'orders',
      readings: [
        { meaning: 'Count all orders', sql: 'SELECT count(*) AS n FROM orders' },
        { meaning: 'Count distinct order ids', sql: 'SELECT count(DISTINCT order_id) AS n FROM orders' },
      ],
    });
    const { runner } = setup(new ScriptedProvider([sameRows, 'Counts the orders table.']));
    const out = await runner.start({ runId: randomUUID(), question: 'How many orders?', mode: 'execution' });
    expect(out.status).toBe('complete');
    if (out.status !== 'complete') return;
    expect(out.answer.path).toBe('readings-agree');
    expect(out.answer.consideredReadings).toEqual(['Count distinct order ids']);
  });

  it('treats results that differ only by rounding as the same answer', async () => {
    const reply = JSON.stringify({
      ambiguous_term: 'revenue',
      readings: [
        { meaning: 'Total payments, rounded', sql: 'SELECT round(sum(payment_value), 2) AS revenue FROM order_payments' },
        { meaning: 'Total payments, unrounded', sql: 'SELECT sum(payment_value) AS revenue FROM order_payments' },
      ],
    });
    const { runner } = setup(new ScriptedProvider([reply, 'x']));
    const out = await runner.start({ runId: randomUUID(), question: 'Total revenue?', mode: 'execution' });
    expect(out.status).toBe('complete');
  });

  it('re-drafts with the database error when SQL fails, then succeeds', async () => {
    const bad = JSON.stringify({ readings: [{ meaning: 'Count', sql: 'SELECT count(*) FROM ordrs' }] });
    const good = JSON.stringify({ readings: [{ meaning: 'Count orders', sql: 'SELECT count(*) AS n FROM orders' }] });
    const llm = new ScriptedProvider([bad, good, 'Counts orders.']);
    const { runner } = setup(llm);
    const out = await runner.start({ runId: randomUUID(), question: 'How many orders are there?', mode: 'execution' });
    expect(out.status).toBe('complete');
    // the second draft prompt carries the first failure back to the model
    const secondDraft = llm.calls[1]!;
    expect(secondDraft.user).toMatch(/PREVIOUS ATTEMPTS FAILED/);
    expect(secondDraft.user).toMatch(/Table "ordrs" does not exist/);
  });

  it('gives up cleanly after the retry budget is spent', async () => {
    const bad = JSON.stringify({ readings: [{ meaning: 'Bad', sql: 'DELETE FROM orders' }] });
    const llm = new ScriptedProvider([bad, bad, bad, bad]);
    const { runner } = setup(llm);
    const out = await runner.start({ runId: randomUUID(), question: 'Delete everything', mode: 'execution' });
    expect(out.status).toBe('failed');
    if (out.status === 'failed') expect(out.error).toMatch(/couldn't produce a working query/i);
    expect(llm.calls).toHaveLength(3); // first try + 2 retries
  });

  it('repairs a reply that is not valid JSON once, then fails if it is still invalid', async () => {
    const good = JSON.stringify({ readings: [{ meaning: 'Count orders', sql: 'SELECT count(*) AS n FROM orders' }] });
    const llm = new ScriptedProvider(['sorry, here you go: not json', good, 'x']);
    const { runner } = setup(llm);
    const ok = await runner.start({ runId: randomUUID(), question: 'How many orders?', mode: 'execution' });
    expect(ok.status).toBe('complete');

    const llm2 = new ScriptedProvider(['nope', 'still nope']);
    const { runner: r2 } = setup(llm2);
    const bad = await r2.start({ runId: randomUUID(), question: 'How many orders?', mode: 'execution' });
    expect(bad.status).toBe('failed');
  });

  it('rejects SQL that tries to read personal data and tells the model why', async () => {
    const pii = JSON.stringify({ readings: [{ meaning: 'Zip codes', sql: 'SELECT customer_zip_code_prefix FROM customers' }] });
    const fixed = JSON.stringify({ readings: [{ meaning: 'Customers per state', sql: 'SELECT customer_state, count(*) AS n FROM customers GROUP BY 1' }] });
    const llm = new ScriptedProvider([pii, fixed, 'x']);
    const { runner } = setup(llm);
    const out = await runner.start({ runId: randomUUID(), question: 'zip codes of customers', mode: 'execution' });
    expect(out.status).toBe('complete');
    expect(llm.calls[1]!.user).toMatch(/restricted/);
  });

  it('baseline mode never asks: it takes one reading', async () => {
    const { runner } = setup();
    const out = await runner.start({ runId: randomUUID(), question: 'Who is our best customer?', mode: 'baseline' });
    expect(out.status).toBe('complete');
  });

  it('classifier mode asks using the model opinion, without previews, then answers from the chosen meaning', async () => {
    const { runner } = setup();
    const runId = randomUUID();
    const first = await runner.start({ runId, question: 'How many customers do we have?', mode: 'classifier' });
    expect(first.status).toBe('awaiting_clarification');
    if (first.status !== 'awaiting_clarification') return;
    expect(first.clarification.options.every((o) => !o.preview)).toBe(true);
    const unique = first.clarification.options.find((o) => /unique people/i.test(o.meaning))!;
    const second = await runner.resume(runId, { optionId: unique.id });
    expect(second.status).toBe('complete');
    if (second.status === 'complete') expect(second.answer.result.rows[0]![0]).toBe(3000);
  });

  it('accepts a free-text clarification and drafts again with it', async () => {
    const { runner } = setup();
    const runId = randomUUID();
    const first = await runner.start({ runId, question: 'Who is our best customer?', mode: 'execution' });
    expect(first.status).toBe('awaiting_clarification');
    const second = await runner.resume(runId, { freeText: 'I mean the person who placed the most orders' });
    expect(second.status).toBe('complete');
    if (second.status === 'complete') {
      expect(second.answer.path).toBe('user-free-text');
      expect(second.answer.meaning).toMatch(/how many orders/i);
    }
  });

  it('counts tokens and LLM calls per run', async () => {
    const { runner } = setup();
    const runId = randomUUID();
    const out = await runner.start({ runId, question: 'What is the order status breakdown?', mode: 'execution' });
    expect(out.usage.llmCalls).toBe(2); // draft + explanation
    expect(out.usage.inputTokens).toBeGreaterThan(100);
  });

  it('computes relative dates from the latest order date in the data, not from today', async () => {
    const { runner } = setup(undefined, new MemoryGlossary([{ term: 'last month', definition: 'the previous full calendar month before the as-of date', status: 'approved', source: 'default' }]));
    const out = await runner.start({ runId: randomUUID(), question: 'What were our sales last month?', mode: 'execution' });
    expect(out.status).toBe('complete');
    if (out.status === 'complete') {
      expect(out.answer.sql).toMatch(/2018-07-01/);
      expect(out.answer.assumptions.join(' ')).toMatch(/July 2018/);
      expect(out.answer.result.rows[0]![0]).toBeGreaterThan(1000);
    }
  });
});
