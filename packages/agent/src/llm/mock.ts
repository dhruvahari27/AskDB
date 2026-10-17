import type { LlmProvider, LlmRequest, LlmResponse } from './types';

/**
 * Offline stand-in for a real model so the whole app runs with no API key.
 *
 * It recognises about a dozen demo questions and answers them with hand-written SQL.
 * It is for demos, tests and CI smoke runs ONLY. Anything it does not recognise gets a clearly labelled fallback.
 * Eval numbers produced with this provider mean nothing: the eval CLI refuses to report them as results.
 */

interface MockReading {
  meaning: string;
  sql: string;
  assumptions?: string[];
}
interface Pattern {
  test: RegExp;
  term: string | null;
  build: (ctx: { question: string; asOf: string; hasDef: (term: string) => boolean }) => MockReading[];
}

const NOT_CANCELED = "o.order_status NOT IN ('canceled', 'unavailable')";

function addDays(iso: string, n: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function prevMonth(asOf: string): { start: string; end: string; label: string } {
  const d = new Date(`${asOf}T00:00:00Z`);
  const end = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
  const start = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1));
  const label = start.toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  return { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10), label };
}
function topN(q: string, fallback = 5): number {
  const m = q.match(/\btop\s+(\d{1,2})\b/i);
  return m ? Number(m[1]) : fallback;
}
function wantsLastMonth(q: string) {
  return /last month/i.test(q);
}

const PATTERNS: Pattern[] = [
  {
    test: /(best|top|biggest|most valuable)\s+customers?/i,
    term: 'best customer',
    build: ({ question, asOf }) => {
      const pm = prevMonth(asOf);
      const when = wantsLastMonth(question) ? `AND o.order_purchase_timestamp >= DATE '${pm.start}' AND o.order_purchase_timestamp < DATE '${pm.end}'` : '';
      const asm = wantsLastMonth(question) ? [`'Last month' = ${pm.label}`] : [];
      const n = /best customer\b(?!s)/i.test(question) ? 1 : topN(question, 5);
      return [
        {
          meaning: 'Rank customers by the total amount they paid (payments, including freight)',
          sql: `SELECT c.customer_unique_id, round(sum(p.payment_value), 2) AS total_paid FROM customers c JOIN orders o ON o.customer_id = c.customer_id JOIN order_payments p ON p.order_id = o.order_id WHERE ${NOT_CANCELED} ${when} GROUP BY c.customer_unique_id ORDER BY total_paid DESC, c.customer_unique_id LIMIT ${n}`,
          assumptions: ['Canceled and unavailable orders excluded', ...asm],
        },
        {
          meaning: 'Rank customers by how many orders they placed',
          sql: `SELECT c.customer_unique_id, count(DISTINCT o.order_id) AS orders_placed FROM customers c JOIN orders o ON o.customer_id = c.customer_id WHERE ${NOT_CANCELED} ${when} GROUP BY c.customer_unique_id ORDER BY orders_placed DESC, c.customer_unique_id LIMIT ${n}`,
          assumptions: ['Canceled and unavailable orders excluded', ...asm],
        },
        {
          meaning: 'Rank customers by what they spent on products (item prices, excluding freight)',
          sql: `SELECT c.customer_unique_id, round(sum(i.price), 2) AS item_spend FROM customers c JOIN orders o ON o.customer_id = c.customer_id JOIN order_items i ON i.order_id = o.order_id WHERE ${NOT_CANCELED} ${when} GROUP BY c.customer_unique_id ORDER BY item_spend DESC, c.customer_unique_id LIMIT ${n}`,
          assumptions: ['Canceled and unavailable orders excluded', ...asm],
        },
      ];
    },
  },
  {
    test: /how many customers|number of customers|customer count|count of customers/i,
    term: 'customers',
    build: () => [
      { meaning: 'Count unique people (customer_unique_id)', sql: 'SELECT count(DISTINCT customer_unique_id) AS customers FROM customers' },
      { meaning: 'Count customer records (customer_id, which is created once per order)', sql: 'SELECT count(*) AS customers FROM customers' },
    ],
  },
  {
    test: /average order value|avg order value|\baov\b/i,
    term: 'average order value',
    build: () => [
      {
        meaning: 'Average of what each order totalled (payments per order)',
        sql: 'SELECT round(avg(t), 2) AS average_order_value FROM (SELECT order_id, sum(payment_value) AS t FROM order_payments GROUP BY order_id) x',
      },
      {
        meaning: 'Average of what each customer spent in total across their orders',
        sql: 'SELECT round(avg(t), 2) AS average_per_customer FROM (SELECT c.customer_unique_id, sum(p.payment_value) AS t FROM customers c JOIN orders o ON o.customer_id = c.customer_id JOIN order_payments p ON p.order_id = o.order_id GROUP BY c.customer_unique_id) x',
      },
    ],
  },
  {
    test: /top\s*\d*\s*sellers?|best sellers?/i,
    term: 'top seller',
    build: ({ question }) => {
      const n = topN(question, 5);
      return [
        {
          meaning: 'Rank sellers by revenue (sum of item prices)',
          sql: `SELECT i.seller_id, round(sum(i.price), 2) AS revenue FROM order_items i JOIN orders o ON o.order_id = i.order_id WHERE ${NOT_CANCELED} GROUP BY i.seller_id ORDER BY revenue DESC, i.seller_id LIMIT ${n}`,
        },
        {
          meaning: 'Rank sellers by number of items sold',
          sql: `SELECT i.seller_id, count(*) AS items_sold FROM order_items i JOIN orders o ON o.order_id = i.order_id WHERE ${NOT_CANCELED} GROUP BY i.seller_id ORDER BY items_sold DESC, i.seller_id LIMIT ${n}`,
        },
      ];
    },
  },
  {
    test: /(sales|revenue)\b.*last month|last month.*(sales|revenue)/i,
    term: 'last month',
    build: ({ asOf, hasDef }) => {
      const pm = prevMonth(asOf);
      const calendar: MockReading = {
        meaning: `Revenue (payments) for the previous calendar month, ${pm.label}`,
        sql: `SELECT round(sum(p.payment_value), 2) AS revenue FROM order_payments p JOIN orders o ON o.order_id = p.order_id WHERE ${NOT_CANCELED} AND o.order_purchase_timestamp >= DATE '${pm.start}' AND o.order_purchase_timestamp < DATE '${pm.end}'`,
        assumptions: [`'Last month' = ${pm.label}`, 'Canceled and unavailable orders excluded'],
      };
      if (hasDef('last month')) return [calendar];
      const from = addDays(asOf, -29);
      return [
        calendar,
        {
          meaning: `Revenue (payments) for the last 30 days up to ${asOf}`,
          sql: `SELECT round(sum(p.payment_value), 2) AS revenue FROM order_payments p JOIN orders o ON o.order_id = p.order_id WHERE ${NOT_CANCELED} AND o.order_purchase_timestamp >= DATE '${from}' AND o.order_purchase_timestamp < DATE '${addDays(asOf, 1)}'`,
          assumptions: [`'Last month' = the 30 days ending ${asOf}`],
        },
      ];
    },
  },
  {
    test: /(top|best)\s*\d*\s*(product\s+)?categor/i,
    term: null,
    build: ({ question }) => [
      {
        meaning: 'Product categories ranked by revenue (item prices, excluding canceled orders)',
        sql: `SELECT t.product_category_name_english AS category, round(sum(i.price), 2) AS revenue FROM order_items i JOIN orders o ON o.order_id = i.order_id JOIN products p ON p.product_id = i.product_id JOIN product_category_name_translation t ON t.product_category_name = p.product_category_name WHERE ${NOT_CANCELED} GROUP BY t.product_category_name_english ORDER BY revenue DESC, category LIMIT ${topN(question, 5)}`,
        assumptions: ['Canceled and unavailable orders excluded', 'Revenue = item prices, excluding freight'],
      },
    ],
  },
  {
    test: /(monthly|per month|by month|each month)/i,
    term: null,
    build: () => [
      {
        meaning: 'Total payments per month, excluding canceled orders',
        sql: `SELECT date_trunc('month', o.order_purchase_timestamp)::date AS month, round(sum(p.payment_value), 2) AS revenue FROM orders o JOIN order_payments p ON p.order_id = o.order_id WHERE ${NOT_CANCELED} GROUP BY 1 ORDER BY 1`,
        assumptions: ['Canceled and unavailable orders excluded'],
      },
    ],
  },
  {
    test: /status/i,
    term: null,
    build: () => [{ meaning: 'Number of orders in each status', sql: 'SELECT order_status, count(*) AS orders FROM orders GROUP BY order_status ORDER BY orders DESC' }],
  },
  {
    test: /review.*state|state.*review/i,
    term: null,
    build: () => [
      {
        meaning: 'Average review score for each customer state',
        sql: 'SELECT c.customer_state, round(avg(r.review_score), 2) AS avg_review_score, count(*) AS reviews FROM order_reviews r JOIN orders o ON o.order_id = r.order_id JOIN customers c ON c.customer_id = o.customer_id GROUP BY c.customer_state ORDER BY avg_review_score DESC',
      },
    ],
  },
  {
    test: /(late|delayed).*deliver|deliver.*(late|delayed)/i,
    term: null,
    build: () => [
      {
        meaning: 'Delivered orders that arrived after the estimated delivery date',
        sql: "SELECT count(*) AS late_orders FROM orders WHERE order_status = 'delivered' AND order_delivered_customer_date > order_estimated_delivery_date",
      },
    ],
  },
  {
    test: /payment (type|method)|how do customers pay/i,
    term: null,
    build: () => [
      {
        meaning: 'Number of payments and total paid per payment type',
        sql: 'SELECT payment_type, count(*) AS payments, round(sum(payment_value), 2) AS total_paid FROM order_payments GROUP BY payment_type ORDER BY total_paid DESC',
      },
    ],
  },
];

function field(user: string, name: string): string {
  const m = user.match(new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}: (.*)$`, 'm'));
  return m ? m[1]!.trim() : '';
}

function parseDefs(user: string): { term: string; def: string }[] {
  const block = user.match(/BUSINESS DEFINITIONS[^\n]*\n([\s\S]*?)\n\n/);
  if (!block) return [];
  return block[1]!
    .split('\n')
    .map((l) => l.match(/^- (.+?) = (.+)$/))
    .filter((m): m is RegExpMatchArray => !!m)
    .map((m) => ({ term: m[1]!.toLowerCase(), def: m[2]! }));
}

function matchPattern(question: string) {
  return PATTERNS.find((p) => p.test.test(question));
}

function readingsFor(user: string): { term: string | null; readings: MockReading[] } {
  const question = field(user, 'QUESTION');
  const asOf = field(user, 'AS_OF') || '2018-08-29';
  const defs = parseDefs(user);
  const hasDef = (t: string) => defs.some((d) => d.term === t);
  const p = matchPattern(question);
  if (!p) {
    return {
      term: null,
      readings: [
        {
          meaning: 'Demo fallback: counting all orders (the offline demo model only understands a few question patterns; set LLM_PROVIDER=groq or gemini for free-form questions)',
          sql: 'SELECT count(*) AS orders FROM orders',
          assumptions: ['Offline demo model: question not recognised'],
        },
      ],
    };
  }
  let readings = p.build({ question, asOf, hasDef });
  // A saved business definition settles which reading is meant.
  const settled = readings.find((r) => defs.some((d) => d.def.trim() === r.meaning.trim()));
  if (settled) readings = [settled];
  const clar = field(user, 'CLARIFICATION FROM THE USER (this settles any ambiguity)');
  if (clar) {
    const words = new Set(clar.toLowerCase().split(/\W+/).filter((w) => w.length > 3));
    const scored = readings.map((r) => ({ r, s: r.meaning.toLowerCase().split(/\W+/).filter((w) => words.has(w)).length }));
    scored.sort((a, b) => b.s - a.s);
    readings = [scored[0]!.r];
  }
  if (/MODE: single/.test(user)) readings = readings.slice(0, 1);
  return { term: p.term, readings };
}

export class MockProvider implements LlmProvider {
  readonly name = 'mock';
  readonly model = 'offline-demo';

  async complete(req: LlmRequest): Promise<LlmResponse> {
    const text = this.respond(req);
    return { text, inputTokens: Math.ceil((req.system.length + req.user.length) / 4), outputTokens: Math.ceil(text.length / 4) };
  }

  private respond(req: LlmRequest): string {
    if (req.system.startsWith('[task:draft]')) {
      const { term, readings } = readingsFor(req.user);
      return JSON.stringify({ ambiguous_term: readings.length > 1 ? term : null, readings });
    }
    if (req.system.startsWith('[task:classify]')) {
      const question = field(req.user, 'QUESTION');
      const asOf = field(req.user, 'AS_OF') || '2018-08-29';
      const defs = parseDefs(req.user);
      const p = matchPattern(question);
      if (!p) return JSON.stringify({ ambiguous: false, ambiguous_term: null, question: null, options: [] });
      const readings = p.build({ question, asOf, hasDef: (t) => defs.some((d) => d.term === t) });
      const settled = readings.some((r) => defs.some((d) => d.def.trim() === r.meaning.trim()));
      if (readings.length < 2 || settled) return JSON.stringify({ ambiguous: false, ambiguous_term: null, question: null, options: [] });
      return JSON.stringify({
        ambiguous: true,
        ambiguous_term: p.term,
        question: `"${p.term}" can be measured in different ways. Which one do you mean?`,
        options: readings.map((r) => ({ meaning: r.meaning })),
      });
    }
    if (req.system.startsWith('[task:simulate_user]')) {
      const intent = (req.user.match(/^TRUE INTENT: (.*)$/m)?.[1] ?? '').toLowerCase();
      const words = new Set(intent.split(/\W+/).filter((w) => w.length > 3));
      let best: { id: string; s: number } | undefined;
      for (const line of req.user.split('\n')) {
        const m = line.match(/^([\w-]+): (.*?)(\s+\[first rows:.*)?$/);
        if (!m || ['YOUR', 'TRUE', 'ASSISTANT', 'OPTIONS'].includes(m[1]!)) continue;
        const s = m[2]!.toLowerCase().split(/\W+/).filter((w) => words.has(w)).length;
        if (!best || s > best.s) best = { id: m[1]!, s };
      }
      return best && best.s > 0 ? JSON.stringify({ optionId: best.id }) : JSON.stringify({ freeText: intent });
    }
    if (req.system.startsWith('[task:explain]')) {
      const question = field(req.user, 'QUESTION');
      const sql = req.user.match(/SQL:\n([\s\S]*?)\n\nOUTPUT COLUMNS/)?.[1] ?? '';
      const tables = [...new Set([...sql.matchAll(/\b(?:from|join)\s+([a-z_]+)/gi)].map((m) => m[1]!.toLowerCase()))];
      return `To answer "${question}", the query combines ${tables.join(', ') || 'the warehouse data'}${/group by/i.test(sql) ? ', groups the rows' : ''}${/order by/i.test(sql) ? ' and sorts the result' : ''}. Canceled and unavailable orders are left out where it matters.`;
    }
    return '{}';
  }
}
