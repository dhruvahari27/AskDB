import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Icon } from './ui';

const STEPS = [
  {
    title: 'Ask your data in plain English',
    body: 'Type a question like "How many delivered orders arrived late?". AskDB writes the SQL, runs it read-only, and shows you a table, a chart, the SQL itself and a plain-language explanation.',
    visual: (
      <div className="tour-vis">
        <div className="bubble-user" style={{ alignSelf: 'flex-start' }}>What is the order status breakdown?</div>
        <div className="tour-mini"><b>order_status</b><span>delivered · 3,329</span><span>shipped · 99</span><span>processing · 89</span></div>
      </div>
    ),
  },
  {
    title: 'It asks you back only when it matters',
    body: 'Some words are genuinely ambiguous: "best customer" can mean most revenue or most orders. AskDB tries each meaning, compares the real results, and only interrupts you if they differ. You see a preview of each so the choice is easy.',
    visual: (
      <div className="tour-vis">
        <div className="tour-opt">By total amount paid <span className="muted">6,921.81</span></div>
        <div className="tour-opt">By number of orders <span className="muted">22</span></div>
        <p className="muted small">If both meanings gave the same answer, you would never see this.</p>
      </div>
    ),
  },
  {
    title: 'Your choices teach it',
    body: 'When you pick a meaning, AskDB saves it as a proposed glossary definition. An admin approves it on the Glossary page, and from then on nobody gets asked that question again. The first account created is the admin.',
    visual: (
      <div className="tour-vis">
        <div className="tour-mini"><b>best customer</b><span>= highest total amount paid</span><span className="chip accent" style={{ alignSelf: 'flex-start' }}>proposed → approved</span></div>
      </div>
    ),
  },
  {
    title: 'Safe by design',
    body: 'The model can only read. Every query is parsed and checked, runs in a read-only transaction with a time limit, and personal-data columns are hidden from the model entirely. You can always open the SQL tab and the Trace panel to see exactly what happened.',
    visual: (
      <div className="tour-vis">
        <div className="row wrap"><span className="chip ok">read-only</span><span className="chip ok">time-limited</span><span className="chip ok">personal data hidden</span><span className="chip indigo">fully traceable</span></div>
      </div>
    ),
  },
];

export function Tour({ onClose }: { onClose: () => void }) {
  const [i, setI] = useState(0);
  const navigate = useNavigate();
  const s = STEPS[i]!;
  const last = i === STEPS.length - 1;
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="card modal tour" role="dialog" aria-modal="true" aria-label="Welcome tour">
        <div className="row">
          <span className="chip accent">Welcome · {i + 1} of {STEPS.length}</span>
          <span className="spacer" />
          <button className="btn ghost sm" onClick={onClose}>Skip</button>
        </div>
        <h2 style={{ fontSize: 21 }}>{s.title}</h2>
        <p style={{ lineHeight: 1.6 }}>{s.body}</p>
        {s.visual}
        <div className="tour-dots" aria-hidden="true">{STEPS.map((_, k) => <i key={k} className={k === i ? 'on' : ''} />)}</div>
        <div className="row">
          <button className="btn" onClick={() => setI(i - 1)} disabled={i === 0}>Back</button>
          <span className="spacer" />
          {last ? (
            <button className="btn primary" onClick={() => { onClose(); navigate('/ask'); }}><Icon name="chat" size={16} /> Ask my first question</button>
          ) : (
            <button className="btn primary" onClick={() => setI(i + 1)}>Next</button>
          )}
        </div>
      </div>
    </div>
  );
}
