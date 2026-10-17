export type Mode = 'baseline' | 'classifier' | 'execution';

export interface CaseResult {
  caseId: string;
  mode: Mode;
  question: string;
  isAmbiguous: boolean;
  ambiguityType?: string;
  split: 'dev' | 'test';
  correct: boolean;
  asked: boolean;
  turns: number;
  ms: number;
  tokens: number;
  llmCalls: number;
  predictedSql?: string;
  error?: string;
}

export interface ModeSummary {
  n: number;
  executionAccuracy: number;
  accuracyAmbiguous: number | null;
  accuracyClear: number | null;
  overAskRate: number | null;
  ambiguityRecall: number | null;
  avgTurns: number;
  p50Ms: number;
  p95Ms: number;
  tokensPerQuestion: number;
}

const rate = (num: number, den: number): number | null => (den === 0 ? null : num / den);

export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const idx = Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1));
  return s[idx]!;
}

/**
 * Metrics, defined once:
 *  - execution accuracy: share of questions whose final result matches the gold result
 *  - over-asking: share of CLEAR questions where the system asked anyway
 *  - ambiguity recall: share of AMBIGUOUS questions where the system asked
 *  - turns: 1 + number of clarification questions
 */
export function summarize(results: CaseResult[]): ModeSummary {
  const amb = results.filter((r) => r.isAmbiguous);
  const clear = results.filter((r) => !r.isAmbiguous);
  const n = results.length;
  return {
    n,
    executionAccuracy: rate(results.filter((r) => r.correct).length, n) ?? 0,
    accuracyAmbiguous: rate(amb.filter((r) => r.correct).length, amb.length),
    accuracyClear: rate(clear.filter((r) => r.correct).length, clear.length),
    overAskRate: rate(clear.filter((r) => r.asked).length, clear.length),
    ambiguityRecall: rate(amb.filter((r) => r.asked).length, amb.length),
    avgTurns: n ? results.reduce((s, r) => s + r.turns, 0) / n : 0,
    p50Ms: percentile(results.map((r) => r.ms), 50),
    p95Ms: percentile(results.map((r) => r.ms), 95),
    tokensPerQuestion: n ? results.reduce((s, r) => s + r.tokens, 0) / n : 0,
  };
}

export function summarizeByMode(results: CaseResult[]): Partial<Record<Mode, ModeSummary>> {
  const out: Partial<Record<Mode, ModeSummary>> = {};
  for (const mode of ['baseline', 'classifier', 'execution'] as Mode[]) {
    const rs = results.filter((r) => r.mode === mode);
    if (rs.length) out[mode] = summarize(rs);
  }
  return out;
}
