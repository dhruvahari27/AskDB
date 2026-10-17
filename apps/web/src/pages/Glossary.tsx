import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api, type GlossaryTerm } from '../api';
import { useSession } from '../App';
import { setFlag } from '../hints';
import { Modal, useToast } from '../ui';

type Filter = 'all' | 'proposed' | 'approved' | 'rejected';

export function GlossaryPage() {
  const { user } = useSession();
  const toast = useToast();
  const [terms, setTerms] = useState<GlossaryTerm[] | null>(null);
  const [filter, setFilter] = useState<Filter>('all');
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<GlossaryTerm | null>(null);
  const isAdmin = user.role === 'admin';

  const load = useCallback(() => api<{ terms: GlossaryTerm[] }>('/glossary').then((r) => setTerms(r.terms)).catch((e) => toast(e.message, true)), [toast]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => { setFlag(user.id, 'glossary-seen'); }, [user.id]);

  async function patch(t: GlossaryTerm, body: object, msg: string) {
    try { await api(`/glossary/${t.id}`, { method: 'PATCH', body }); toast(msg); await load(); } catch (e) { toast((e as Error).message, true); }
  }
  async function remove(t: GlossaryTerm) {
    if (!window.confirm(`Delete "${t.term}"?`)) return;
    try { await api(`/glossary/${t.id}`, { method: 'DELETE' }); toast('Deleted'); await load(); } catch (e) { toast((e as Error).message, true); }
  }

  const shown = (terms ?? []).filter((t) => filter === 'all' || t.status === filter);
  const count = (f: Filter) => (terms ?? []).filter((t) => f === 'all' || t.status === f).length;

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Glossary</h1>
          <p>Business definitions the assistant must follow. Only <b>approved</b> terms are used, so one user's guess can't change everyone's answers.</p>
        </div>
        <span className="spacer" />
        <button className="btn primary" onClick={() => setAdding(true)}>Add a term</button>
      </div>

      <div className="seg" role="tablist">
        {(['all', 'proposed', 'approved', 'rejected'] as Filter[]).map((f) => (
          <button key={f} className={filter === f ? 'on' : ''} onClick={() => setFilter(f)}>{f[0]!.toUpperCase() + f.slice(1)} · {count(f)}</button>
        ))}
      </div>

      <section className="card" style={{ overflowX: 'auto' }}>
        {!terms ? <div className="skeleton" style={{ height: 160 }} /> : shown.length === 0 ? (
          <p className="muted card-pad">Nothing here. When someone picks an option on a clarification, the choice shows up as a proposal.</p>
        ) : (
          <table className="tbl">
            <thead><tr><th>Term</th><th>Definition</th><th>Status</th><th>Source</th><th /></tr></thead>
            <tbody>
              {shown.map((t) => (
                <tr key={t.id}>
                  <td><b>{t.term}</b></td>
                  <td>{t.definition}{t.sqlSnippet && <div className="mono small muted" style={{ marginTop: 3 }}>{t.sqlSnippet}</div>}</td>
                  <td><span className={`chip ${t.status === 'approved' ? 'ok' : t.status === 'proposed' ? 'accent' : 'bad'}`}>{t.status}</span></td>
                  <td className="muted small">{t.source === 'clarification' ? 'learned from a user' : t.source}{t.createdByEmail ? ` · ${t.createdByEmail}` : ''}</td>
                  <td>
                    {isAdmin ? (
                      <div className="row wrap" style={{ justifyContent: 'flex-end' }}>
                        {t.status !== 'approved' && <button className="btn sm" onClick={() => patch(t, { status: 'approved' }, 'Approved')}>Approve</button>}
                        {t.status !== 'rejected' && <button className="btn sm" onClick={() => patch(t, { status: 'rejected' }, 'Rejected')}>Reject</button>}
                        <button className="btn sm ghost" onClick={() => setEditing(t)}>Edit</button>
                        <button className="btn sm ghost danger" onClick={() => remove(t)}>Delete</button>
                      </div>
                    ) : <span className="muted small">admin only</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {adding && <TermForm title="Add a term" admin={isAdmin} onClose={() => setAdding(false)} onSaved={() => { setAdding(false); void load(); }} />}
      {editing && <TermForm title="Edit term" initial={editing} admin onClose={() => setEditing(null)} onSaved={() => { setEditing(null); void load(); }} />}
    </div>
  );
}

function TermForm({ title, initial, admin, onClose, onSaved }: { title: string; initial?: GlossaryTerm; admin: boolean; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [term, setTerm] = useState(initial?.term ?? '');
  const [definition, setDefinition] = useState(initial?.definition ?? '');
  const [sqlSnippet, setSql] = useState(initial?.sqlSnippet ?? '');
  const [busy, setBusy] = useState(false);
  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      if (initial) await api(`/glossary/${initial.id}`, { method: 'PATCH', body: { term, definition } });
      else await api('/glossary', { body: { term, definition, ...(sqlSnippet ? { sqlSnippet } : {}) } });
      toast(initial ? 'Saved' : admin ? 'Added and approved' : 'Submitted for review');
      onSaved();
    } catch (err) { toast((err as Error).message, true); } finally { setBusy(false); }
  }
  return (
    <Modal title={title} onClose={onClose}>
      <form className="stack" onSubmit={save}>
        <label className="field">Term<input className="input" required minLength={2} value={term} onChange={(e) => setTerm(e.target.value)} placeholder="e.g. best customer" /></label>
        <label className="field">Definition<textarea className="input" required minLength={3} rows={3} value={definition} onChange={(e) => setDefinition(e.target.value)} placeholder="e.g. the customer with the highest total payment value" /></label>
        {!initial && <label className="field">SQL hint (optional)<input className="input mono" value={sqlSnippet} onChange={(e) => setSql(e.target.value)} placeholder="sum(op.payment_value)" /></label>}
        {!admin && <p className="muted small">Your term will be reviewed by an admin before it is used.</p>}
        <div className="row"><span className="spacer" /><button type="button" className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={busy}>Save</button></div>
      </form>
    </Modal>
  );
}
