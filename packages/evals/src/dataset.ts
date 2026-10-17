import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { repoRoot } from '@askdb/shared';
import { z } from 'zod';

export const CaseSchema = z.object({
  id: z.string().min(1),
  question: z.string().min(3),
  lang: z.string().default('en'),
  isAmbiguous: z.boolean(),
  ambiguityType: z.enum(['metric', 'time', 'entity', 'aggregation', 'scope', 'join path']).optional(),
  /** what the asker really meant (ambiguous cases only); the simulated user answers from this */
  trueIntent: z.string().optional(),
  /** SQL for the true intent. May contain {{placeholders}} for dates derived from the as-of date. */
  goldSql: z.string().min(10),
  split: z.enum(['dev', 'test']).default('dev'),
});
export type EvalCase = z.infer<typeof CaseSchema>;

export const DATASET_PATH = resolve(repoRoot, 'packages/evals/data/cases.json');

export function loadCases(path = DATASET_PATH): EvalCase[] {
  if (!existsSync(path)) throw new Error(`Eval dataset not found at ${path}`);
  const raw = JSON.parse(readFileSync(path, 'utf8')) as unknown[];
  const cases = raw.map((c, i) => {
    const r = CaseSchema.safeParse(c);
    if (!r.success) throw new Error(`Case #${i} is invalid: ${r.error.issues.map((x) => `${x.path.join('.')}: ${x.message}`).join('; ')}`);
    return r.data;
  });
  const ids = new Set<string>();
  for (const c of cases) {
    if (ids.has(c.id)) throw new Error(`Duplicate case id ${c.id}`);
    ids.add(c.id);
    if (c.isAmbiguous && (!c.trueIntent || !c.ambiguityType)) throw new Error(`Ambiguous case ${c.id} needs trueIntent and ambiguityType`);
  }
  return cases;
}

const iso = (d: Date) => d.toISOString().slice(0, 10);
const utc = (y: number, m: number, d = 1) => new Date(Date.UTC(y, m, d));

/** Dates the gold queries may reference, all derived from the data's as-of date (never from today's date). */
export function dateVars(asOf: string): Record<string, string> {
  const d = new Date(`${asOf}T00:00:00Z`);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  const q = Math.floor(m / 3);
  return {
    as_of: asOf,
    tomorrow: iso(new Date(d.getTime() + 86_400_000)),
    month_start: iso(utc(y, m)),
    prev_month_start: iso(utc(y, m - 1)),
    quarter_start: iso(utc(y, q * 3)),
    prev_quarter_start: iso(utc(y, q * 3 - 3)),
    year_start: iso(utc(y, 0)),
    prev_year_start: iso(utc(y - 1, 0)),
  };
}

export function expandGold(sql: string, asOf: string): string {
  const vars = dateVars(asOf);
  return sql.replace(/\{\{(\w+)\}\}/g, (_, k: string) => {
    const v = vars[k];
    if (v === undefined) throw new Error(`Unknown placeholder {{${k}}} in gold SQL`);
    return v;
  });
}
