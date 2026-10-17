import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, streamRun, type AgentMode, type AnswerPayload, type Candidate, type Clarification, type ConversationSummary, type RunEvent, type StoredMessage } from '../api';
import { DataTable, Icon, MiniTable, Modal, ResultChart, Spinner, SqlView, fmtMs, timeAgo, useToast } from '../ui';

const MODES: { id: AgentMode; label: string; hint: string }[] = [
  { id: 'execution', label: 'Execution', hint: 'Runs several readings and asks only if their results differ (default).' },
  { id: 'classifier', label: 'Classifier', hint: 'An LLM guesses whether the question is ambiguous. No result previews.' },
  { id: 'baseline', label: 'Baseline', hint: 'Never asks. Always answers with its single best guess.' },
];

const SAMPLES = [
  { tag: 'Clear', q: 'What is the order status breakdown?' },
  { tag: 'Clear', q: 'How many customers do we have?' },
  { tag: 'Clear', q: 'How many delivered orders arrived late?' },
  { tag: 'Ambiguous', q: 'Who is our best customer?' },
  { tag: 'Ambiguous', q: 'Show the top 5 sellers' },
  { tag: 'Uses glossary', q: 'What was the revenue last month?' },
];

interface Live { runId: string; events: RunEvent[] }

export function AskPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const [convs, setConvs] = useState<ConversationSummary[]>([]);
  const [messages, setMessages] = useState<StoredMessage[]>([]);
  const [mode, setMode] = useState<AgentMode>('execution');
  const [text, setText] = useState('');
  const [live, setLive] = useState<Live | null>(null);
  const [sending, setSending] = useState(false);
  const [traceFor, setTraceFor] = useState<string | null>(null);
  const [showTrace, setShowTrace] = useState(true);
  const stopRef = useRef<(() => void) | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const idRef = useRef(id);
  idRef.current = id;

  const loadConvs = useCallback(() => api<{ conversations: ConversationSummary[] }>('/conversations').then((r) => setConvs(r.conversations)).catch(() => {}), []);
  useEffect(() => { void loadConvs(); }, [loadConvs]);

  const loadMessages = useCallback(async (convId: string) => {
    const r = await api<{ conversation: { mode: AgentMode }; messages: StoredMessage[] }>(`/conversations/${convId}`);
    if (idRef.current !== convId) return [] as StoredMessage[];
    setMessages(r.messages);
    setMode(r.conversation.mode);
    return r.messages;
  }, []);

  const attach = useCallback((runId: string, convId: string) => {
    stopRef.current?.();
    setLive({ runId, events: [] });
    stopRef.current = streamRun(
      runId,
      (e) => setLive((l) => (l && l.runId === runId ? { ...l, events: [...l.events, e] } : l)),
      () => {
        stopRef.current = null;
        void loadMessages(convId).finally(() => {
          setLive((l) => (l && l.runId === runId ? null : l));
          void loadConvs();
        });
      },
    );
  }, [loadMessages, loadConvs]);

  // Load the conversation when the route changes; re-attach to a run that is still going (e.g. after a page reload).
  useEffect(() => {
    stopRef.current?.();
    stopRef.current = null;
    setLive(null);
    setTraceFor(null);
    if (!id) { setMessages([]); return; }
    let cancelled = false;
    loadMessages(id)
      .then((msgs) => {
        if (cancelled) return;
        const running = [...msgs].reverse().find((m) => m.role === 'assistant' && m.status === 'running' && m.runId);
        if (running?.runId) attach(running.runId, id);
      })
      .catch(() => { if (!cancelled) { toast('Conversation not found', true); navigate('/ask', { replace: true }); } });
    return () => { cancelled = true; stopRef.current?.(); };
  }, [id, loadMessages, attach, navigate, toast]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  }, [messages.length, live?.events.length]);

  async function ask(question: string) {
    const q = question.trim();
    if (q.length < 3 || sending || live) return;
    setSending(true);
    try {
      let convId = id;
      if (!convId) {
        const c = await api<{ conversation: { id: string } }>('/conversations', { body: { mode } });
        convId = c.conversation.id;
      }
      const r = await api<{ runId: string }>(`/conversations/${convId}/ask`, { body: { question: q, mode } });
      setText('');
      if (id !== convId) {
        idRef.current = convId;
        navigate(`/ask/${convId}`);
        // route effect loads messages and attaches to the running run
      } else {
        await loadMessages(convId);
        attach(r.runId, convId);
      }
      void loadConvs();
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setSending(false);
    }
  }

  async function clarify(runId: string, body: { optionId?: string; freeText?: string }) {
    if (!id) return;
    try {
      await api(`/runs/${runId}/clarify`, { body });
      await loadMessages(id);
      attach(runId, id);
    } catch (e) {
      toast((e as Error).message, true);
      void loadMessages(id);
    }
  }

  async function newChat() { navigate('/ask'); }
  async function removeConv(cid: string) {
    if (!window.confirm('Delete this conversation?')) return;
    await api(`/conversations/${cid}`, { method: 'DELETE' }).catch((e) => toast(e.message, true));
    if (cid === id) navigate('/ask');
    void loadConvs();
  }

  function onKey(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void ask(text); }
  }

  const busy = sending || !!live;
  const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant');
  const traceMsg = messages.find((m) => m.id === traceFor) ?? lastAssistant;
  const traceEvents: RunEvent[] = live ? live.events : (traceMsg?.result?.trace ?? []);

  return (
    <div className={`ask ${showTrace ? 'with-trace' : ''}`}>
      <aside className="conv-list" aria-label="Conversations">
        <div className="head">
          <button className="btn primary" onClick={newChat}><Icon name="plus" size={16} /> New conversation</button>
        </div>
        <div className="conv-items">
          {convs.length === 0 && <p className="muted small" style={{ padding: 10 }}>Your conversations appear here.</p>}
          {convs.map((c) => (
            <div key={c.id} className={`conv-item ${c.id === id ? 'active' : ''}`}>
              <Link to={`/ask/${c.id}`} className="title link-reset" title={c.title}>{c.title}</Link>
              <span className="muted small">{timeAgo(c.updatedAt)}</span>
              <button className="btn icon ghost x" style={{ width: 24, height: 24, padding: 2 }} aria-label="Delete conversation" onClick={() => void removeConv(c.id)}><Icon name="x" size={14} /></button>
            </div>
          ))}
        </div>
      </aside>

      <section className="chat">
        <div className="chat-head">
          <b>{convs.find((c) => c.id === id)?.title ?? 'New conversation'}</b>
          <span className="spacer" />
          <button className="btn sm ghost" onClick={() => setShowTrace((s) => !s)} title="Show or hide the live reasoning trace"><Icon name="trace" size={16} /> Trace</button>
        </div>

        <div className="chat-scroll" ref={scrollRef}>
          <div className="chat-inner">
            {messages.length === 0 && !live && (
              <div className="empty">
                <div className="brand" style={{ padding: 0 }}><span className="logo" style={{ width: 44, height: 44, borderRadius: 12 }}><Icon name="logo" size={24} /></span></div>
                <h2>What do you want to know?</h2>
                <p className="muted" style={{ maxWidth: 560 }}>Ask about orders, customers, sellers, products, payments or reviews. If a question can mean two different things, you'll see both answers' previews and choose.</p>
                <div className="hint" style={{ maxWidth: 560, textAlign: 'left' }}><span>💡</span><span><b>First time here?</b> Click a sample below. "Clear" ones answer straight away. "Ambiguous" ones show you how AskDB asks back. <Link to="/help">Open the help page</Link>.</span></div>
                <div className="samples">
                  {SAMPLES.map((s) => (
                    <button key={s.q} className="sample" onClick={() => void ask(s.q)} disabled={busy}><span className="tag">{s.tag}</span>{s.q}</button>
                  ))}
                </div>
              </div>
            )}

            {messages.map((m) => {
              if (m.role === 'user') return <div key={m.id} className="bubble-user">{m.content}</div>;
              const isLive = !!live && live.runId === m.runId;
              if (isLive || m.status === 'running') return <Thinking key={m.id} events={live?.events ?? []} />;
              const r = m.result;
              if (!r) return null;
              if (r.kind === 'answer') {
                return <AnswerCard key={m.id} msg={m} answer={r.answer} onTrace={() => { setTraceFor(m.id); setShowTrace(true); }} />;
              }
              if (r.kind === 'clarification') {
                return <ClarifyCard key={m.id} runId={m.runId!} clarification={r.clarification} answered={false} onPick={(b) => clarify(m.runId!, b)} />;
              }
              return (
                <div key={m.id} className="card card-pad stack" style={{ borderColor: 'var(--danger)' }}>
                  <div className="row"><span className="chip bad">Couldn't answer</span></div>
                  <p>{r.message}</p>
                  <p className="muted small">Try naming the table or metric you mean, for example "total payment value" instead of "revenue".</p>
                </div>
              );
            })}
          </div>
        </div>

        <div className="composer">
          <div className="composer-inner">
            <div className="row wrap">
              <div className="mode-pick" role="radiogroup" aria-label="Mode">
                {MODES.map((m) => (
                  <button key={m.id} role="radio" aria-checked={mode === m.id} className={mode === m.id ? 'on' : ''} title={m.hint} onClick={() => setMode(m.id)} disabled={busy}>{m.label}</button>
                ))}
              </div>
              <span className="muted small">{MODES.find((m) => m.id === mode)?.hint}</span>
            </div>
            <div className="composer-box">
              <textarea rows={1} value={text} onChange={(e) => setText(e.target.value)} onKeyDown={onKey} placeholder="Ask a question about your data…" aria-label="Question" maxLength={1000} />
              <button className="btn primary" onClick={() => void ask(text)} disabled={busy || text.trim().length < 3} aria-label="Send"><Icon name="send" size={16} /> Ask</button>
            </div>
          </div>
        </div>
      </section>

      {showTrace && <TracePanel events={traceEvents} running={!!live} />}
    </div>
  );
}

/* ---------------- thinking bubble ---------------- */
function Thinking({ events }: { events: RunEvent[] }) {
  const last = [...events].reverse().find((e) => e.type === 'step' && e.status === 'start');
  return (
    <div className="thinking" role="status">
      <Spinner /> <span>{last && last.type === 'step' ? last.label : 'Working on it'}…</span>
    </div>
  );
}

/* ---------------- answer ---------------- */
type TabId = 'table' | 'chart' | 'sql' | 'explain';

function AnswerCard({ msg, answer, onTrace }: { msg: StoredMessage; answer: AnswerPayload; onTrace: () => void }) {
  const toast = useToast();
  const [tab, setTab] = useState<TabId>('table');
  const [rating, setRating] = useState<number | null>(msg.feedbackRating);
  const [fixing, setFixing] = useState(false);
  const empty = answer.result.rowCount === 0;
  const tabs: [TabId, string][] = [['table', 'Table'], ...(answer.chart.type !== 'none' ? ([['chart', 'Chart']] as [TabId, string][]) : []), ['sql', 'SQL'], ['explain', 'Explanation']];

  async function thumbUp() {
    try { await api(`/messages/${msg.id}/feedback`, { body: { rating: 1 } }); setRating(1); toast('Thanks, noted'); } catch (e) { toast((e as Error).message, true); }
  }
  const pathLabel: Record<AnswerPayload['path'], string> = {
    'single-reading': 'one clear reading',
    'readings-agree': 'readings agreed',
    'user-clarified': 'you chose a meaning',
    'user-free-text': 'you clarified in words',
  };
  return (
    <article className="card answer">
      <div className="answer-head">
        <div className="answer-meaning">{answer.meaning}</div>
        <div className="row wrap">
          <span className="chip ok">{pathLabel[answer.path]}</span>
          {answer.assumptions.map((a, i) => <span key={i} className="chip accent" title="Assumption the answer relies on">{a}</span>)}
          {answer.consideredReadings.length > 0 && <span className="chip indigo" title={answer.consideredReadings.join('\n')}>{answer.consideredReadings.length} other reading{answer.consideredReadings.length === 1 ? '' : 's'} gave the same rows</span>}
        </div>
      </div>
      <div className="tabs" role="tablist">
        {tabs.map(([t, l]) => <button key={t} role="tab" aria-selected={tab === t} className={`tab ${tab === t ? 'on' : ''}`} onClick={() => setTab(t)}>{l}</button>)}
      </div>
      <div className="tab-body">
        {tab === 'table' && (empty ? <p className="muted">The query ran fine but returned no rows. Try a wider date range or a different filter.</p> : <DataTable result={answer.result} />)}
        {tab === 'chart' && <ResultChart result={answer.result} chart={answer.chart} />}
        {tab === 'sql' && (
          <div className="stack">
            <SqlView sql={answer.sql} />
            <div className="row"><button className="btn sm" onClick={() => { void navigator.clipboard?.writeText(answer.sql); toast('SQL copied'); }}><Icon name="copy" size={14} /> Copy</button></div>
          </div>
        )}
        {tab === 'explain' && <p className="explain-text">{answer.explanation}</p>}
      </div>
      <div className="answer-foot">
        <button className={`btn sm ${rating === 1 ? 'primary' : ''}`} onClick={thumbUp} aria-pressed={rating === 1} aria-label="Good answer"><Icon name="up" size={14} /></button>
        <button className={`btn sm ${rating === -1 ? 'primary' : ''}`} onClick={() => setFixing(true)} aria-pressed={rating === -1} aria-label="Wrong answer"><Icon name="down" size={14} /></button>
        <span className="muted small">{rating === -1 ? 'Thanks, your correction was saved.' : 'Was this right?'}</span>
        <span className="spacer" />
        <button className="btn sm ghost" onClick={onTrace}>View trace</button>
      </div>
      {fixing && <FixModal msg={msg} sql={answer.sql} onClose={() => setFixing(false)} onSaved={() => { setFixing(false); setRating(-1); }} />}
    </article>
  );
}

function FixModal({ msg, sql, onClose, onSaved }: { msg: StoredMessage; sql: string; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [corrected, setCorrected] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  async function save() {
    setBusy(true);
    try {
      await api(`/messages/${msg.id}/feedback`, { body: { rating: -1, ...(corrected.trim().length >= 5 ? { correctedSql: corrected.trim() } : {}), ...(note.trim() ? { note: note.trim() } : {}) } });
      toast('Saved. Admins can use your correction as a test case.');
      onSaved();
    } catch (e) { toast((e as Error).message, true); } finally { setBusy(false); }
  }
  return (
    <Modal title="What was wrong?" onClose={onClose}>
      <label className="field">What should it have done? (optional)<textarea className="input" rows={2} value={note} onChange={(e) => setNote(e.target.value)} /></label>
      <label className="field">The correct SQL (optional)<textarea className="input mono" rows={6} value={corrected} onChange={(e) => setCorrected(e.target.value)} placeholder={sql} /></label>
      <div className="row"><span className="spacer" /><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={busy} onClick={save}>Submit</button></div>
    </Modal>
  );
}

/* ---------------- clarification ---------------- */
function ClarifyCard({ clarification, answered, onPick }: { runId: string; clarification: Clarification; answered: boolean; onPick: (b: { optionId?: string; freeText?: string }) => void }) {
  const [free, setFree] = useState('');
  const [sent, setSent] = useState(false);
  const locked = answered || sent;
  const pick = (b: { optionId?: string; freeText?: string }) => { setSent(true); onPick(b); };
  return (
    <article className="card card-pad stack clarify">
      <div className="row"><span className="chip indigo">Your call</span><span className="muted small">The readings below return different results.</span></div>
      <div className="q">{clarification.question}</div>
      <div className="opt-grid">
        {clarification.options.map((o) => (
          <button key={o.id} className="opt" disabled={locked} onClick={() => pick({ optionId: o.id })}>
            <span className="m">{o.meaning}</span>
            {o.preview && <MiniTable preview={o.preview} />}
            <span className="chip indigo" style={{ alignSelf: 'flex-start' }}>Use this meaning</span>
          </button>
        ))}
      </div>
      {clarification.allowFreeText && (
        <div className="row">
          <input className="input" placeholder="None of these — I mean…" value={free} disabled={locked} onChange={(e) => setFree(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && free.trim().length >= 2 && pick({ freeText: free.trim() })} aria-label="Describe what you mean" />
          <button className="btn indigo" disabled={locked || free.trim().length < 2} onClick={() => pick({ freeText: free.trim() })}>Send</button>
        </div>
      )}
      <details className="why">
        <summary>Why am I being asked this?</summary>
        <p>AskDB wrote a query for each possible meaning and ran them all. The results were different, so guessing would have risked giving you the wrong number. The previews show the first rows each meaning returns. Choose the one that matches what you meant, or describe it in your own words.</p>
        <p>Your choice is saved as a <i>proposed</i> glossary definition. After an admin approves it, nobody gets asked this again.</p>
      </details>
    </article>
  );
}

/* ---------------- trace ---------------- */
function TracePanel({ events, running }: { events: RunEvent[]; running: boolean }) {
  const steps = useMemo(() => {
    const out: { key: string; label: string; status: 'run' | 'done'; ms?: number; detail?: string }[] = [];
    for (const e of events) {
      if (e.type !== 'step') continue;
      const existing = [...out].reverse().find((s) => s.key === e.node && s.status === 'run');
      if (e.status === 'start' || !existing) {
        if (e.status === 'start') out.push({ key: e.node, label: e.label, status: 'run', detail: e.detail });
        else out.push({ key: e.node, label: e.label, status: 'done', ms: e.ms, detail: e.detail });
      } else {
        existing.status = 'done';
        existing.ms = e.ms;
        existing.detail = e.detail ?? existing.detail;
      }
    }
    return out;
  }, [events]);
  const cands = useMemo(() => {
    const last = [...events].reverse().find((e) => e.type === 'candidates');
    return last && last.type === 'candidates' ? last.candidates : ([] as Candidate[]);
  }, [events]);
  const assumptions = events.filter((e): e is Extract<RunEvent, { type: 'assumption' }> => e.type === 'assumption');
  const done = [...events].reverse().find((e): e is Extract<RunEvent, { type: 'done' }> => e.type === 'done');

  return (
    <aside className="trace" aria-label="Reasoning trace">
      <div className="head"><b>Trace</b>{running && <Spinner />}<span className="spacer" />{done?.durationMs !== undefined && <span className="chip">{fmtMs(done.durationMs)}</span>}</div>
      <div className="trace-body">
        {steps.length === 0 && <p className="muted small">Ask a question to watch the steps happen live: reading the schema, drafting readings, running each one, and comparing their results.</p>}
        {steps.map((s, i) => (
          <div key={i} className={`step ${s.status}`}>
            <span className="dot">{s.status === 'done' ? '✓' : '…'}</span>
            <div style={{ minWidth: 0 }}>
              <div>{s.label}</div>
              {s.detail && <div className="detail">{s.detail}</div>}
            </div>
            {s.ms !== undefined && <span className="ms">{fmtMs(s.ms)}</span>}
          </div>
        ))}
        {cands.length > 0 && (
          <div className="stack" style={{ gap: 8 }}>
            <h3>Readings tried</h3>
            {cands.map((c) => (
              <div key={c.id} className={`cand ${c.status === 'error' || c.status === 'rejected' ? 'err' : ''}`}>
                <div className="row"><b style={{ fontSize: 12.5 }}>{c.meaning}</b></div>
                <div className="row wrap">
                  <span className={`chip ${c.status === 'ok' ? 'ok' : c.status === 'pending' ? '' : 'bad'}`}>{c.status}</span>
                  {c.rowCount !== undefined && <span className="chip">{c.rowCount} rows</span>}
                </div>
                {c.error && <div className="small" style={{ color: 'var(--danger)' }}>{c.error}</div>}
              </div>
            ))}
          </div>
        )}
        {assumptions.length > 0 && (
          <div className="stack" style={{ gap: 6 }}>
            <h3>Assumptions</h3>
            {assumptions.map((a, i) => <div key={i} className="small muted">• {a.text}</div>)}
          </div>
        )}
        {done?.usage && <p className="muted small">{done.usage.llmCalls} model call{done.usage.llmCalls === 1 ? '' : 's'} · {(done.usage.inputTokens + done.usage.outputTokens).toLocaleString()} tokens</p>}
      </div>
    </aside>
  );
}
