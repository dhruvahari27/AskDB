import { describe, expect, it } from 'vitest';
import { dateVars, expandGold, loadCases } from '../src/dataset';
import { percentile, summarize, type CaseResult } from '../src/metrics';
import { Harness } from '../src/harness';
import { MockProvider } from '@askdb/agent';
import { createReadOnlyPool } from '@askdb/sql-guard';
import { getConfig } from '@askdb/shared';
import { warehouseAvailable } from '../../agent/test/helpers';

const mk = (o: Partial<CaseResult>): CaseResult => ({ caseId: 'x', mode: 'execution', question: 'q', isAmbiguous: false, split: 'dev', correct: true, asked: false, turns: 1, ms: 100, tokens: 10, llmCalls: 1, ...o });

describe('metrics', () => {
  it('computes accuracy, over-asking and recall on the right denominators', () => {
    const s = summarize([
      mk({ isAmbiguous: false, correct: true, asked: false }),
      mk({ isAmbiguous: false, correct: false, asked: true, turns: 2 }),
      mk({ isAmbiguous: true, correct: true, asked: true, turns: 2 }),
      mk({ isAmbiguous: true, correct: false, asked: false }),
    ]);
    expect(s.executionAccuracy).toBe(0.5);
    expect(s.accuracyClear).toBe(0.5);
    expect(s.accuracyAmbiguous).toBe(0.5);
    expect(s.overAskRate).toBe(0.5);
    expect(s.ambiguityRecall).toBe(0.5);
    expect(s.avgTurns).toBe(1.5);
  });
  it('returns null (not 0) when a group is empty', () => {
    const s = summarize([mk({})]);
    expect(s.accuracyAmbiguous).toBeNull();
    expect(s.ambiguityRecall).toBeNull();
  });
  it('percentiles', () => {
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 50)).toBe(5);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 95)).toBe(10);
    expect(percentile([], 50)).toBe(0);
  });
});

describe('dataset', () => {
  it('loads and validates, with ambiguous cases carrying an intent', () => {
    const cases = loadCases();
    expect(cases.length).toBeGreaterThanOrEqual(30);
    expect(cases.some((c) => c.isAmbiguous)).toBe(true);
    expect(cases.some((c) => !c.isAmbiguous)).toBe(true);
    expect(cases.some((c) => c.split === 'test')).toBe(true);
  });
  it('derives dates from the as-of date, not from today', () => {
    const v = dateVars('2018-08-29');
    expect(v).toMatchObject({ prev_month_start: '2018-07-01', month_start: '2018-08-01', prev_quarter_start: '2018-04-01', quarter_start: '2018-07-01', year_start: '2018-01-01', prev_year_start: '2017-01-01', tomorrow: '2018-08-30' });
    expect(dateVars('2018-01-15').prev_month_start).toBe('2017-12-01');
    expect(dateVars('2018-02-10').prev_quarter_start).toBe('2017-10-01');
    expect(expandGold("x >= DATE '{{prev_month_start}}'", '2018-08-29')).toContain('2018-07-01');
    expect(() => expandGold('{{nope}}', '2018-08-29')).toThrow();
  });
});

describe.skipIf(!(await warehouseAvailable()))('harness (needs the warehouse)', () => {
  const cfg = getConfig();
  const pool = createReadOnlyPool(cfg.WAREHOUSE_READONLY_URL, 3);
  const h = new Harness({ llm: new MockProvider(), warehouse: pool, limits: { timeoutMs: 5000, maxRows: 500, maxPlanCost: 5_000_000 }, useDefaultGlossary: false });

  it('every gold query passes the guard and runs', async () => {
    for (const c of loadCases()) {
      const rows = await h.goldRows(c);
      expect(rows.length, `${c.id} returned no rows`).toBeGreaterThan(0);
    }
  });

  it('scores a case end to end, asking in execution mode and not in baseline', async () => {
    const c = loadCases().find((x) => x.id === 'a01')!;
    const gold = await h.goldRows(c);
    const exec = await h.runCase(c, 'execution', gold);
    expect(exec.asked).toBe(true);
    expect(exec.turns).toBe(2);
    const base = await h.runCase(c, 'baseline', gold);
    expect(base.asked).toBe(false);
    expect(base.turns).toBe(1);
  });
});
