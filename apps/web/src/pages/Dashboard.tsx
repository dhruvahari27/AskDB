import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { api } from '../api';
import { useSession } from '../App';
import { useFlag } from '../hints';
import { fmtMs, timeAgo } from '../ui';

interface Stats {
  totals: { runs: number; completed: number; failed: number; clarified: number; avgDurationMs: number; tokens: number };
  tokensToday: number;
  tokenBudget: number;
  glossary: { approved: number; proposed: number };
  recent: { id: string; question: string; status: string; mode: string; durationMs: number | null; rowCount: number | null; conversationId: string; createdAt: string; clarified: boolean }[];
  perDay: { day: string; runs: number; clarified: number }[];
  asOf: string | null;
  provider: string;
}

export function Dashboard() {
  const [s, setS] = useState<Stats | null>(null);
  const [err, setErr] = useState('');
  const { user } = useSession();
  const [glossarySeen] = useFlag(user.id, 'glossary-seen');
  const [schemaSeen] = useFlag(user.id, 'schema-seen');
  const [hidden, setHidden] = useFlag(user.id, 'checklist-hidden');
  useEffect(() => { api<Stats>('/stats').then(setS).catch((e) => setErr(e.message)); }, []);

  if (err) return <div className="page"><div className="error-box">{err}</div></div>;
  if (!s) return <div className="page"><div className="skeleton" style={{ height: 90 }} /><div className="skeleton" style={{ height: 300 }} /></div>;

  const pct = s.tokenBudget > 0 ? Math.min(100, Math.round((s.tokensToday / s.tokenBudget) * 100)) : 0;
  const askRate = s.totals.runs ? Math.round((s.totals.clarified / s.totals.runs) * 100) : 0;
  const data = s.perDay.map((d) => ({ day: d.day.slice(5), 'Answered directly': d.runs - d.clarified, 'Needed a question': d.clarified }));

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Overview</h1>
          <p>Warehouse data runs through <b>{s.asOf ?? 'n/a'}</b>, so "last month" means the month before that date.</p>
        </div>
        <span className="spacer" />
        <span className="chip indigo" title="Language model provider">LLM: {s.provider}</span>
        <Link className="btn primary" to="/ask">Ask a question</Link>
      </div>

      {!hidden && (() => {
        const items = [
          { label: 'Ask your first question', hint: 'Click a sample on the Ask page', done: s.totals.runs > 0, to: '/ask' },
          { label: 'Answer a clarifying question', hint: 'Try "Who is our best customer?" and pick a meaning', done: s.totals.clarified > 0, to: '/ask' },
          { label: 'Review what it learned', hint: user.role === 'admin' ? 'Approve your choice on the Glossary page' : 'See the proposed definition on the Glossary page', done: glossarySeen, to: '/glossary' },
          { label: 'See what data it can use', hint: 'The Schema page shows tables and hidden personal data', done: schemaSeen, to: '/schema' },
        ];
        const n = items.filter((i) => i.done).length;
        return (
          <section className="card card-pad stack" aria-label="Getting started">
            <div className="row"><h2>Getting started</h2><span className="chip accent">{n} of {items.length}</span><span className="spacer" /><Link className="btn sm ghost" to="/help">Help</Link><button className="btn sm ghost" onClick={() => setHidden(true)}>Hide</button></div>
            <div className="meter"><span style={{ width: `${(n / items.length) * 100}%` }} /></div>
            <div className="checklist">
              {items.map((i) => (
                <Link key={i.label} to={i.to} className={`check-item ${i.done ? 'done' : ''}`}>
                  <span className="tick">✓</span>
                  <span><span className="label">{i.label}</span><br /><span className="muted small">{i.hint}</span></span>
                  {!i.done && <span className="btn sm go">Go</span>}
                </Link>
              ))}
            </div>
          </section>
        );
      })()}

      <div className="stat-grid">
        <div className="card stat"><span className="label">Questions asked</span><span className="value">{s.totals.runs}</span><span className="sub">{s.totals.completed} answered · {s.totals.failed} failed</span></div>
        <div className="card stat"><span className="label">Asked back</span><span className="value">{askRate}%</span><span className="sub">{s.totals.clarified} of {s.totals.runs} needed a clarification</span></div>
        <div className="card stat"><span className="label">Avg. answer time</span><span className="value">{fmtMs(s.totals.avgDurationMs) || '—'}</span><span className="sub">includes all SQL runs</span></div>
        <div className="card stat"><span className="label">Glossary</span><span className="value">{s.glossary.approved}</span><span className="sub">approved terms · {s.glossary.proposed} waiting for review</span></div>
      </div>

      <div className="grid-2">
        <section className="card card-pad stack">
          <h2>Last 7 days</h2>
          <div style={{ width: '100%', height: 250 }}>
            <ResponsiveContainer>
              <BarChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: -18 }}>
                <CartesianGrid stroke="var(--border)" vertical={false} />
                <XAxis dataKey="day" stroke="var(--muted)" fontSize={12} tickLine={false} />
                <YAxis stroke="var(--muted)" fontSize={12} tickLine={false} allowDecimals={false} />
                <Tooltip contentStyle={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 10, color: 'var(--text)' }} cursor={{ fill: 'color-mix(in srgb, var(--accent) 12%, transparent)' }} />
                <Legend />
                <Bar dataKey="Answered directly" stackId="a" fill="var(--c1)" maxBarSize={40} />
                <Bar dataKey="Needed a question" stackId="a" fill="var(--c3)" radius={[5, 5, 0, 0]} maxBarSize={40} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </section>

        <section className="card card-pad stack">
          <h2>Today's AI budget</h2>
          <div className="meter" aria-label={`${pct}% used`}><span style={{ width: `${pct}%` }} /></div>
          <div className="row"><b>{s.tokensToday.toLocaleString()}</b><span className="muted">of {s.tokenBudget.toLocaleString()} tokens</span><span className="spacer" /><span className="chip">{pct}%</span></div>
          <p className="muted small">The budget protects the shared API key. It resets at midnight UTC. Lifetime use: {s.totals.tokens.toLocaleString()} tokens.</p>
          <h3 style={{ marginTop: 6 }}>How it works</h3>
          <ol className="small muted" style={{ margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 4 }}>
            <li>The model drafts a few readings of your question.</li>
            <li>Each reading is checked by a SQL parser, then run read-only.</li>
            <li>If every reading returns the same rows, you get the answer.</li>
            <li>If rows differ, you see both and choose. Your choice becomes a glossary proposal.</li>
          </ol>
        </section>
      </div>

      <section className="card card-pad">
        <div className="row" style={{ marginBottom: 6 }}><h2>Recent questions</h2></div>
        {s.recent.length === 0 && <p className="muted">Nothing yet. <Link to="/ask">Ask your first question</Link>.</p>}
        {s.recent.map((r) => (
          <Link key={r.id} className="list-row link-reset" to={`/ask/${r.conversationId}`}>
            <span className="t">{r.question}</span>
            {r.clarified && <span className="chip indigo">asked back</span>}
            <span className={`chip ${r.status === 'complete' ? 'ok' : r.status === 'failed' ? 'bad' : ''}`}>{r.status.replace('_', ' ')}</span>
            <span className="chip">{r.mode}</span>
            <span className="muted small" style={{ width: 70, textAlign: 'right' }}>{timeAgo(r.createdAt)}</span>
          </Link>
        ))}
      </section>
    </div>
  );
}
