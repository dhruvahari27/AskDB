import { useEffect, useState } from 'react';
import { api } from '../api';
import { useSession } from '../App';
import { setFlag } from '../hints';

interface Col { name: string; type: string; description?: string; pii?: boolean; isPk?: boolean; fk: { table: string; column: string } | string | null }
interface Table { name: string; description?: string; rowEstimate?: number; columns: Col[] }

export function SchemaPage() {
  const [data, setData] = useState<{ asOf: string | null; tables: Table[] } | null>(null);
  const [q, setQ] = useState('');
  const [err, setErr] = useState('');
  const { user } = useSession();
  useEffect(() => { setFlag(user.id, 'schema-seen'); }, [user.id]);
  useEffect(() => { api('/schema').then(setData).catch((e) => setErr(e.message)); }, []);
  if (err) return <div className="page"><div className="error-box">{err}</div></div>;
  if (!data) return <div className="page"><div className="skeleton" style={{ height: 300 }} /></div>;
  const tables = data.tables.filter((t) => !q || t.name.includes(q.toLowerCase()) || t.columns.some((c) => c.name.includes(q.toLowerCase())));
  const piiCount = data.tables.reduce((n, t) => n + t.columns.filter((c) => c.pii).length, 0);
  const fkText = (fk: Col['fk']) => (fk ? (typeof fk === 'string' ? fk : `${fk.table}.${fk.column}`) : '');
  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Schema</h1>
          <p>What the assistant can see. {piiCount} personal-data column{piiCount === 1 ? '' : 's'} are hidden from the model and blocked by the SQL guard.</p>
        </div>
        <span className="spacer" />
        <input className="input" style={{ maxWidth: 240 }} placeholder="Filter tables or columns" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Filter" />
      </div>
      <div className="schema-grid">
        {tables.map((t) => (
          <section key={t.name} className="card card-pad stack" style={{ gap: 6 }}>
            <div className="row"><h2 className="mono" style={{ fontSize: 15 }}>{t.name}</h2><span className="spacer" />{t.rowEstimate !== undefined && <span className="chip">~{Math.max(0, t.rowEstimate).toLocaleString()} rows</span>}</div>
            {t.description && <p className="muted small">{t.description}</p>}
            <div>
              {t.columns.map((c) => (
                <div className="col-row" key={c.name} title={c.description}>
                  <span className="n">{c.name}</span>
                  {c.isPk && <span className="chip accent">pk</span>}
                  {c.fk && <span className="chip indigo" title="foreign key">→ {fkText(c.fk)}</span>}
                  {c.pii && <span className="chip bad">personal data</span>}
                  <span className="ty">{c.type}</span>
                </div>
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}
