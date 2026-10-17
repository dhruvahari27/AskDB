import { useEffect, useState } from 'react';
import { api } from '../api';
import { timeAgo } from '../ui';

interface ModeSummary {
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
interface RunSummary { id: string; startedAt: string; provider: string; model: string; commit?: string; cases: number; modes: Record<string, ModeSummary> }
interface CaseResult { caseId: string; mode: string; question: string; isAmbiguous: boolean; correct: boolean; asked: boolean; turns: number; ms: number; tokens: number; predictedSql?: string; error?: string }
interface Dataset { total: number; clear: number; ambiguous: number; heldOut?: number; byType: Record<string, number> }

const pct = (v: number | null | undefined) => (v === null || v === undefined ? '—' : `${(v * 100).toFixed(0)}%`);
const MODE_LABEL: Record<string, string> = { baseline: 'Baseline (never asks)', classifier: 'LLM classifier', execution: 'Execution-based' };
const MODE_COLOR: Record<string, string> = { baseline: 'var(--c6)', classifier: 'var(--c2)', execution: 'var(--c1)' };

export function EvalsPage() {
  const [runs, setRuns] = useState<RunSummary[] | null>(null);
  const [ds, setDs] = useState<Dataset | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  const [detail, setDetail] = useState<{ results: CaseResult[] } | null>(null);
  const [onlyWrong, setOnlyWrong] = useState(true);

  useEffect(() => {
    api<{ runs: RunSummary[] }>('/evals/runs').then((r) => { setRuns(r.runs); if (r.runs[0]) setSel(r.runs[0].id); }).catch(() => setRuns([]));
    api<Dataset>('/evals/dataset').then(setDs).catch(() => {});
  }, []);
  useEffect(() => {
    if (!sel) return;
    setDetail(null);
    api(`/evals/runs/${sel}`).then(setDetail).catch(() => {});
  }, [sel]);

  const run = runs?.find((r) => r.id === sel);
  const modes = run ? ['baseline', 'classifier', 'execution'].filter((m) => run.modes[m]) : [];

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Evaluation</h1>
          <p>Does asking back actually help? The same questions are run in three modes and scored by <b>execution accuracy</b>: does the result match the gold query's result?</p>
        </div>
        <span className="spacer" />
        {runs && runs.length > 1 && (
          <select className="input" style={{ width: 'auto' }} value={sel ?? ''} onChange={(e) => setSel(e.target.value)} aria-label="Eval run">
            {runs.map((r) => <option key={r.id} value={r.id}>{r.model} · {timeAgo(r.startedAt)}</option>)}
          </select>
        )}
      </div>

      {ds && (
        <div className="row wrap">
          <span className="chip">{ds.total} questions</span><span className="chip ok">{ds.clear} clear</span><span className="chip indigo">{ds.ambiguous} ambiguous</span>
          {Object.entries(ds.byType).map(([k, v]) => <span key={k} className="chip">{k}: {v}</span>)}
        </div>
      )}

      {runs === null && <div className="skeleton" style={{ height: 220 }} />}
      {runs && runs.length === 0 && (
        <section className="card card-pad stack">
          <h2>No evaluation runs yet</h2>
          <p className="muted">Numbers here come from real model runs, never from the offline demo model. Add a free Groq or Gemini key to <code>.env</code>, then run:</p>
          <pre className="sql">npm run evals -- --modes baseline,classifier,execution</pre>
          <p className="muted small">Results are saved to <code>packages/evals/results/</code> and appear here automatically.</p>
        </section>
      )}

      {run && (
        <>
          <div className="row wrap muted small">
            <span className="chip indigo">{run.provider}</span><span className="chip">{run.model}</span><span>{run.cases} cases</span>{run.commit && <span className="mono">{run.commit}</span>}
          </div>
          <div className="stat-grid">
            {modes.map((m) => {
              const s = run.modes[m]!;
              return (
                <section key={m} className="card stat" style={{ borderTop: `3px solid ${MODE_COLOR[m]}` }}>
                  <span className="label">{MODE_LABEL[m]}</span>
                  <span className="value">{pct(s.executionAccuracy)}</span>
                  <span className="sub">execution accuracy · n={s.n}</span>
                </section>
              );
            })}
          </div>
          <section className="card" style={{ overflowX: 'auto' }}>
            <table className="tbl">
              <thead><tr><th>Metric</th>{modes.map((m) => <th key={m}>{MODE_LABEL[m]}</th>)}</tr></thead>
              <tbody>
                {([
                  ['Accuracy, ambiguous questions', (s: ModeSummary) => pct(s.accuracyAmbiguous)],
                  ['Accuracy, clear questions', (s: ModeSummary) => pct(s.accuracyClear)],
                  ['Over-asking (asked on a clear question)', (s: ModeSummary) => pct(s.overAskRate)],
                  ['Ambiguity recall (asked on an ambiguous one)', (s: ModeSummary) => pct(s.ambiguityRecall)],
                  ['Average turns', (s: ModeSummary) => s.avgTurns.toFixed(2)],
                  ['Latency p50 / p95', (s: ModeSummary) => `${(s.p50Ms / 1000).toFixed(1)}s / ${(s.p95Ms / 1000).toFixed(1)}s`],
                  ['Tokens per question', (s: ModeSummary) => Math.round(s.tokensPerQuestion).toLocaleString()],
                ] as [string, (s: ModeSummary) => string][]).map(([label, f]) => (
                  <tr key={label}><td>{label}</td>{modes.map((m) => <td key={m}><b>{f(run.modes[m]!)}</b></td>)}</tr>
                ))}
              </tbody>
            </table>
          </section>

          <section className="card card-pad stack">
            <div className="row"><h2>Per-question results</h2><span className="spacer" />
              <label className="row small"><input type="checkbox" checked={onlyWrong} onChange={(e) => setOnlyWrong(e.target.checked)} /> only failures</label>
            </div>
            {!detail ? <div className="skeleton" style={{ height: 120 }} /> : (
              <div style={{ overflowX: 'auto' }}>
                <table className="tbl">
                  <thead><tr><th>Question</th><th>Mode</th><th>Type</th><th>Result</th><th>Asked</th></tr></thead>
                  <tbody>
                    {detail.results.filter((r) => !onlyWrong || !r.correct).slice(0, 150).map((r, i) => (
                      <tr key={i}>
                        <td>{r.question}{r.error && <div className="small" style={{ color: 'var(--danger)' }}>{r.error}</div>}</td>
                        <td><span className="chip">{r.mode}</span></td>
                        <td>{r.isAmbiguous ? <span className="chip indigo">ambiguous</span> : <span className="chip">clear</span>}</td>
                        <td><span className={`chip ${r.correct ? 'ok' : 'bad'}`}>{r.correct ? 'correct' : 'wrong'}</span></td>
                        <td>{r.asked ? 'yes' : 'no'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {detail.results.filter((r) => !onlyWrong || !r.correct).length === 0 && <p className="muted">No failures in this run.</p>}
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}
