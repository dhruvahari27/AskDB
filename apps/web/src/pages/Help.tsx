import { Link } from 'react-router-dom';
import { useSession } from '../App';
import { setFlag } from '../hints';

const GOOD: [string, string, string][] = [
  ['Name the measure', 'Show the top sellers', 'Show the top 5 sellers by total item price'],
  ['Give a time window', 'How many orders recently?', 'How many orders were placed in 2017?'],
  ['Say what you are counting', 'How many customers?', 'How many distinct customers (people) do we have?'],
];

const FAQ: [string, string][] = [
  ['Why did it ask me a question?', 'Because it tried more than one reasonable meaning of your question and the actual results were different. If every reading had returned the same rows, it would simply have answered. Pick the option that matches what you meant, or type your own meaning if none fit.'],
  ['Why did it NOT ask me, and give a result I did not expect?', 'Either every reading agreed, or an approved glossary definition settled it. Open the assumption chips on the answer, the SQL tab and the Trace panel to see what it assumed. Press the thumbs-down and paste the correct SQL; admins can turn corrections into test cases.'],
  ['What do the three modes do?', 'Execution (default) runs several readings and asks only if results differ. Classifier lets a language model guess whether to ask, without result previews. Baseline never asks and uses its single best guess. They exist so the evaluation page can compare them fairly.'],
  ['What does "last month" mean? The data looks old.', 'Relative dates are measured from the newest order in the data (shown on the Overview page), not from today. The sample data ends on 2018-08-29, so "last month" means July 2018.'],
  ['Can it change or delete my data?', 'No. The database role is read-only, every query runs inside a read-only transaction with a time limit, and SQL that is not a single SELECT is rejected before it runs.'],
  ['Why can I not see some columns?', 'Personal-data columns (zip codes, review comments) are hidden from the model and blocked by the SQL guard. The Schema page marks them.'],
  ['Who can approve glossary terms?', 'Admins only. The first account created becomes the admin. Everyone else can propose terms and see which are approved.'],
  ['The offline demo model only answers a few questions.', 'That is the "mock" provider, used so the app works with no API key. Set LLM_PROVIDER to groq or gemini in the .env file, add a key, and restart for free-form questions.'],
  ['I hit a budget or rate limit message.', 'Each user has a daily token budget and a per-minute question limit to protect the shared API key. The budget resets at midnight UTC.'],
];

export function HelpPage({ onTour }: { onTour: () => void }) {
  const { user } = useSession();
  return (
    <div className="page">
      <div className="page-head">
        <div><h1>Help &amp; first steps</h1><p>Everything you need to get a good answer on your first day.</p></div>
        <span className="spacer" />
        <button className="btn" onClick={onTour}>Replay the welcome tour</button>
        <Link className="btn primary" to="/ask" onClick={() => setFlag(user.id, 'help-seen')}>Start asking</Link>
      </div>

      <section className="card card-pad stack">
        <h2>Your first five minutes</h2>
        <ol className="steps">
          <li><b>Open Ask</b> and click a sample question. "What is the order status breakdown?" is a clear one.</li>
          <li><b>Look at the tabs</b> on the answer: Table, Chart, SQL, Explanation. Click a column header to sort.</li>
          <li><b>Try an ambiguous question</b>: "Who is our best customer?" You will be asked to choose a meaning, with a preview of each.</li>
          <li><b>Open the Trace panel</b> on the right to watch each step, including the readings it tried.</li>
          <li><b>Visit Glossary</b>: your choice appears as a proposal. {user.role === 'admin' ? 'You are the admin, so approve it, then ask again and notice the question disappears.' : 'Ask your admin to approve it.'}</li>
        </ol>
      </section>

      <section className="card card-pad stack">
        <h2>Asking questions that get good answers</h2>
        <div style={{ overflowX: 'auto' }}>
          <table className="tbl">
            <thead><tr><th>Tip</th><th>Vague</th><th>Better</th></tr></thead>
            <tbody>{GOOD.map(([t, a, b]) => <tr key={t}><td><b>{t}</b></td><td className="muted">{a}</td><td>{b}</td></tr>)}</tbody>
          </table>
        </div>
        <ul className="muted" style={{ margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 4 }}>
          <li>Ask one thing at a time. Follow up in a new question rather than a long paragraph.</li>
          <li>Use table words from the Schema page (orders, sellers, payments, reviews, products, customers).</li>
          <li>If an answer looks wrong, open the SQL tab first. It is the fastest way to see what the model assumed.</li>
        </ul>
      </section>

      <section className="card card-pad stack">
        <h2>Where things are</h2>
        <div className="stat-grid">
          {[
            ['Overview', '/', 'Your activity, daily AI budget, recent questions.'],
            ['Ask', '/ask', 'Conversations, answers, live trace, feedback.'],
            ['Glossary', '/glossary', 'Definitions the assistant must follow.'],
            ['Schema', '/schema', 'Tables and columns it can see; hidden personal data.'],
            ['Evaluation', '/evals', 'Does asking back actually help? Per-mode scores.'],
          ].map(([n, to, d]) => <Link key={to} to={to!} className="card stat link-reset" style={{ boxShadow: 'none' }}><b>{n}</b><span className="sub">{d}</span></Link>)}
        </div>
      </section>

      <section className="card card-pad stack">
        <h2>Frequently asked</h2>
        {FAQ.map(([q, a]) => (
          <details key={q} className="faq">
            <summary>{q}</summary>
            <p className="muted">{a}</p>
          </details>
        ))}
      </section>
    </div>
  );
}
