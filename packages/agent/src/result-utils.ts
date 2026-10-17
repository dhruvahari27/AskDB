import type { ChartSpec, TabularResult } from '@askdb/shared';

const ISO_DATE_LIKE = /^\d{4}-\d{2}(-\d{2})?([ T].*)?$/;

/** Pick a sensible chart from the shape of the result. No LLM involved: the shape decides. */
export function chartFor(r: TabularResult): ChartSpec {
  if (r.rowCount === 0 || r.columns.length === 0) return { type: 'none' };
  const numeric = r.columns.map((c, i) => (c.type === 'number' ? i : -1)).filter((i) => i >= 0);

  if (r.rowCount === 1 && r.columns.length === 1 && numeric.length === 1) return { type: 'stat', y: [0] };
  if (r.columns.length < 2 || numeric.length === 0) return { type: 'none' };

  const x = 0;
  if (numeric.includes(x)) return { type: 'none' };
  const y = numeric.filter((i) => i !== x).slice(0, 3);
  if (y.length === 0) return { type: 'none' };

  const col = r.rows.map((row) => row[x]);
  const looksTemporal = r.columns[x]!.type === 'date' || col.every((v) => typeof v === 'string' && ISO_DATE_LIKE.test(v));
  if (looksTemporal && r.rowCount >= 3) return { type: 'line', x, y };
  if (r.rowCount >= 2 && r.rowCount <= 40) return { type: 'bar', x, y };
  return { type: 'none' };
}

/** Names of the tables a SQL string reads, for the offline explanation fallback. */
export function tablesIn(sql: string): string[] {
  const out = new Set<string>();
  for (const m of sql.matchAll(/\b(?:from|join)\s+(?:analytics\.)?([a-z_][a-z0-9_]*)/gi)) out.add(m[1]!.toLowerCase());
  return [...out];
}

export function templateExplanation(question: string, sql: string, assumptions: string[]): string {
  const tables = tablesIn(sql).filter((t) => !['select', 'lateral'].includes(t));
  const parts = [`To answer "${question.trim()}", the query reads ${tables.length ? tables.join(', ') : 'the warehouse'}`];
  if (/\bgroup by\b/i.test(sql)) parts.push('groups the rows');
  if (/\border by\b/i.test(sql)) parts.push('sorts the result');
  if (/\blimit\b/i.test(sql)) parts.push('keeps only the top rows');
  let text = parts.join(', ') + '.';
  if (assumptions.length) text += ` Assumptions: ${assumptions.join('; ')}.`;
  return text;
}

export function extractJson(text: string): unknown {
  let t = text.trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1]!.trim();
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) throw new Error('no JSON object found in the reply');
  return JSON.parse(t.slice(start, end + 1));
}

export function normalizeSqlForCompare(sql: string): string {
  return sql.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\s+/g, ' ').replace(/;+\s*$/, '').trim().toLowerCase();
}
