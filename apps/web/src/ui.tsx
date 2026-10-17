import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { Bar, BarChart, CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { Cell, ChartSpec, ColumnMeta, TabularResult } from '@askdb/shared/schemas';

/* ---------------- icons ---------------- */
const P: Record<string, string> = {
  logo: 'M4 6c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3zm0 0v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3',
  home: 'M3 11l9-8 9 8M5 10v10h5v-6h4v6h5V10',
  chat: 'M21 12a8 8 0 01-11.6 7.1L4 20l1-4.6A8 8 0 1121 12z',
  book: 'M4 5a2 2 0 012-2h13v16H6a2 2 0 00-2 2V5zm2 14h13v2H6',
  table: 'M3 5h18v14H3zM3 10h18M9 5v14',
  flask: 'M9 3h6M10 3v6l-5 9a2 2 0 002 3h10a2 2 0 002-3l-5-9V3',
  sun: 'M12 4V2m0 20v-2m8-8h2M2 12h2m13.7-5.7l1.4-1.4M4.9 19.1l1.4-1.4m0-11.4L4.9 4.9m14.2 14.2l-1.4-1.4M12 8a4 4 0 100 8 4 4 0 000-8z',
  moon: 'M21 13A9 9 0 1111 3a7 7 0 0010 10z',
  plus: 'M12 5v14M5 12h14',
  send: 'M5 12h14m-6-6l6 6-6 6',
  up: 'M7 11l5-5 5 5M12 6v13',
  down: 'M7 13l5 5 5-5M12 18V5',
  x: 'M6 6l12 12M18 6L6 18',
  check: 'M5 12l5 5 9-10',
  logout: 'M15 4h4a1 1 0 011 1v14a1 1 0 01-1 1h-4M10 8l-4 4 4 4M6 12h10',
  shield: 'M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6l8-3z',
  trace: 'M4 6h16M4 12h10M4 18h6',
  copy: 'M8 8h11v13H8zM5 16V3h11',
  help: 'M9.5 9a2.5 2.5 0 114 2c-.9.7-1.5 1.2-1.5 2.5M12 17.5v.01M12 3a9 9 0 100 18 9 9 0 000-18z',
};
export function Icon({ name, size = 18 }: { name: keyof typeof P | string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={P[name] ?? ''} />
    </svg>
  );
}

/* ---------------- toast ---------------- */
interface Toast { id: number; text: string; bad?: boolean }
const ToastCtx = createContext<(text: string, bad?: boolean) => void>(() => {});
export const useToast = () => useContext(ToastCtx);
export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Toast[]>([]);
  const push = useCallback((text: string, bad?: boolean) => {
    const id = Date.now() + Math.random();
    setItems((s) => [...s, { id, text, bad }]);
    setTimeout(() => setItems((s) => s.filter((t) => t.id !== id)), 4200);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {items.map((t) => (
          <div key={t.id} className={`toast ${t.bad ? 'bad' : ''}`}>{t.text}</div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="card modal" role="dialog" aria-modal="true" aria-label={title}>
        <div className="row">
          <h2>{title}</h2>
          <span className="spacer" />
          <button className="btn ghost icon" onClick={onClose} aria-label="Close"><Icon name="x" /></button>
        </div>
        {children}
      </div>
    </div>
  );
}

/* ---------------- formatting ---------------- */
export function fmtCell(v: Cell, type?: ColumnMeta['type']): string {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'number') {
    if (Number.isInteger(v)) return v.toLocaleString('en-US');
    return v.toLocaleString('en-US', { maximumFractionDigits: 2 });
  }
  if (type === 'date' && typeof v === 'string') return v.replace('T', ' ').replace(/\.\d+$/, '').replace(/ 00:00:00$/, '');
  return String(v);
}
export const fmtMs = (ms?: number) => (ms === undefined ? '' : ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`);
export function timeAgo(iso: string): string {
  const s = Math.max(1, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

/* ---------------- SQL highlighter (tiny, display only) ---------------- */
const KEYWORDS = new Set(
  'select from where group by order having limit offset join left right inner outer full cross on as and or not in is null like ilike between case when then else end distinct union all with over partition desc asc exists using interval date timestamp cast true false extract filter'.split(' '),
);
export function SqlView({ sql }: { sql: string }) {
  const parts = useMemo(() => {
    const out: ReactNode[] = [];
    const re = /(--[^\n]*)|('(?:[^']|'')*')|(\b\d+(?:\.\d+)?\b)|([A-Za-z_][A-Za-z0-9_]*)(\s*\()?|([\s\S])/g;
    let m: RegExpExecArray | null;
    let i = 0;
    while ((m = re.exec(sql))) {
      const key = i++;
      if (m[1]) out.push(<span key={key} className="c">{m[1]}</span>);
      else if (m[2]) out.push(<span key={key} className="s">{m[2]}</span>);
      else if (m[3]) out.push(<span key={key} className="n">{m[3]}</span>);
      else if (m[4]) {
        const w = m[4];
        if (KEYWORDS.has(w.toLowerCase())) out.push(<span key={key} className="k">{w}{m[5] ?? ''}</span>);
        else if (m[5]) out.push(<span key={key}><span className="f">{w}</span>{m[5]}</span>);
        else out.push(w);
      } else out.push(m[0]);
    }
    return out;
  }, [sql]);
  return <pre className="sql"><code>{parts}</code></pre>;
}

/* ---------------- data table ---------------- */
export function DataTable({ result }: { result: TabularResult }) {
  const [sort, setSort] = useState<{ col: number; dir: 1 | -1 } | null>(null);
  const [shown, setShown] = useState(100);
  const rows = useMemo(() => {
    if (!sort) return result.rows;
    const { col, dir } = sort;
    return [...result.rows].sort((a, b) => {
      const x = a[col] ?? null, y = b[col] ?? null;
      if (x === y) return 0;
      if (x === null) return 1;
      if (y === null) return -1;
      return (x < y ? -1 : 1) * dir;
    });
  }, [result.rows, sort]);
  return (
    <div className="dt-wrap">
      <div className="dt-scroll">
        <table className="dt">
          <thead>
            <tr>
              {result.columns.map((c, i) => (
                <th key={i} className={c.type === 'number' ? 'num' : ''} onClick={() => setSort((s) => (s?.col === i ? (s.dir === 1 ? { col: i, dir: -1 } : null) : { col: i, dir: 1 }))} title="Click to sort">
                  {c.name}{sort?.col === i ? (sort.dir === 1 ? ' ↑' : ' ↓') : ''}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.slice(0, shown).map((r, ri) => (
              <tr key={ri}>
                {r.map((v, ci) => (
                  <td key={ci} className={result.columns[ci]?.type === 'number' ? 'num' : ''}>{fmtCell(v, result.columns[ci]?.type)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="dt-foot">
        <span>{result.rowCount.toLocaleString()} row{result.rowCount === 1 ? '' : 's'}{result.truncated ? ' (result was capped)' : ''}</span>
        {shown < rows.length && <button className="btn sm" onClick={() => setShown((n) => n + 200)}>Show more</button>}
        <span className="spacer" />
        <button className="btn sm ghost" onClick={() => downloadCsv(result)}>Download CSV</button>
      </div>
    </div>
  );
}

function downloadCsv(result: TabularResult) {
  const esc = (v: Cell) => {
    const s = v === null ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const csv = [result.columns.map((c) => esc(c.name)).join(','), ...result.rows.map((r) => r.map(esc).join(','))].join('\n');
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = 'askdb-result.csv';
  a.click();
  URL.revokeObjectURL(url);
}

export function MiniTable({ preview }: { preview: { columns: ColumnMeta[]; rows: Cell[][]; rowCount: number } }) {
  return (
    <div style={{ overflow: 'hidden' }}>
      <table className="mini-table">
        <thead><tr>{preview.columns.map((c, i) => <th key={i} className={c.type === 'number' ? 'num' : ''}>{c.name}</th>)}</tr></thead>
        <tbody>
          {preview.rows.map((r, ri) => (
            <tr key={ri}>{r.map((v, ci) => <td key={ci} className={preview.columns[ci]?.type === 'number' ? 'num' : ''}>{fmtCell(v, preview.columns[ci]?.type)}</td>)}</tr>
          ))}
        </tbody>
      </table>
      <div className="muted small" style={{ marginTop: 4 }}>{preview.rowCount.toLocaleString()} row{preview.rowCount === 1 ? '' : 's'} in total</div>
    </div>
  );
}

/* ---------------- chart ---------------- */
const SERIES = ['var(--c1)', 'var(--c2)', 'var(--c3)', 'var(--c4)', 'var(--c5)', 'var(--c6)'];
export function ResultChart({ result, chart }: { result: TabularResult; chart: ChartSpec }) {
  if (chart.type === 'none') return <p className="muted">This result isn't a good fit for a chart. Use the table.</p>;
  if (chart.type === 'stat') {
    const v = result.rows[0]?.[chart.y?.[0] ?? 0] ?? null;
    return (
      <div className="stat-big">
        <div className="muted small">{result.columns[chart.y?.[0] ?? 0]?.name}</div>
        <div className="v">{fmtCell(v, 'number')}</div>
      </div>
    );
  }
  const x = chart.x ?? 0;
  const ys = chart.y ?? [1];
  const data = result.rows.slice(0, 60).map((r) => {
    const o: Record<string, Cell> = { __x: fmtCell(r[x] ?? null, result.columns[x]?.type) };
    ys.forEach((y) => (o[result.columns[y]!.name] = r[y] ?? null));
    return o;
  });
  const axis = { stroke: 'var(--muted)', fontSize: 12, tickLine: false } as const;
  const common = { data, margin: { top: 8, right: 12, bottom: 4, left: 0 } };
  const tip = <Tooltip contentStyle={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 10, color: 'var(--text)' }} cursor={{ fill: 'color-mix(in srgb, var(--accent) 12%, transparent)' }} />;
  return (
    <div style={{ width: '100%', height: 300 }}>
      <ResponsiveContainer>
        {chart.type === 'line' ? (
          <LineChart {...common}>
            <CartesianGrid stroke="var(--border)" vertical={false} />
            <XAxis dataKey="__x" {...axis} minTickGap={24} />
            <YAxis {...axis} width={56} tickFormatter={(v) => Number(v).toLocaleString('en-US', { notation: 'compact' })} />
            {tip}
            {ys.length > 1 && <Legend />}
            {ys.map((y, i) => <Line key={y} type="monotone" dataKey={result.columns[y]!.name} stroke={SERIES[i % SERIES.length]} strokeWidth={2.4} dot={data.length < 25} />)}
          </LineChart>
        ) : (
          <BarChart {...common}>
            <CartesianGrid stroke="var(--border)" vertical={false} />
            <XAxis dataKey="__x" {...axis} interval={0} angle={data.length > 8 ? -30 : 0} textAnchor={data.length > 8 ? 'end' : 'middle'} height={data.length > 8 ? 70 : 30} tickFormatter={(v) => (String(v).length > 14 ? String(v).slice(0, 13) + '…' : v)} />
            <YAxis {...axis} width={56} tickFormatter={(v) => Number(v).toLocaleString('en-US', { notation: 'compact' })} />
            {tip}
            {ys.length > 1 && <Legend />}
            {ys.map((y, i) => <Bar key={y} dataKey={result.columns[y]!.name} fill={SERIES[i % SERIES.length]} radius={[5, 5, 0, 0]} maxBarSize={48} />)}
          </BarChart>
        )}
      </ResponsiveContainer>
    </div>
  );
}

export function Spinner() {
  return <span className="dots" aria-label="Loading"><i /><i /><i /></span>;
}
