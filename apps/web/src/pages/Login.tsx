import { useState, type FormEvent } from 'react';
import { api } from '../api';
import { Icon } from '../ui';

export function LoginPage({ onDone }: { onDone: () => void }) {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api(`/auth/${mode}`, { body: mode === 'login' ? { email, password } : { email, password, ...(name ? { name } : {}) } });
      onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth-wrap">
      <section className="auth-hero">
        <div className="brand" style={{ color: '#fff' }}><span className="logo"><Icon name="logo" size={18} /></span> AskDB</div>
        <h1>Ask your data in plain English. <em>It asks you back</em> only when the answer would change.</h1>
        <p>AskDB writes several readings of your question, runs them all, and compares the actual results. If they agree, you just get the answer. If they differ, you see both and pick.</p>
        <div className="hero-demo" aria-hidden="true">
          <div className="q">“Who is our best customer?”</div>
          <div className="opt">By total revenue — customer with the highest payments</div>
          <div className="opt">By number of orders — the most frequent buyer</div>
          <div className="muted small" style={{ color: '#9aa0b4' }}>Different readings gave different people, so AskDB asked.</div>
        </div>
      </section>
      <section className="auth-form-wrap">
        <form className="auth-form" onSubmit={submit}>
          <div>
            <h1>{mode === 'login' ? 'Sign in' : 'Create your account'}</h1>
            <p className="muted" style={{ marginTop: 4 }}>{mode === 'login' ? 'Welcome back.' : 'The first account created becomes the admin.'}</p>
          </div>
          {mode === 'register' && (
            <label className="field">Name (optional)<input className="input" value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" /></label>
          )}
          <label className="field">Email<input className="input" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" /></label>
          <label className="field">Password<input className="input" type="password" required minLength={mode === 'register' ? 8 : 1} value={password} onChange={(e) => setPassword(e.target.value)} autoComplete={mode === 'login' ? 'current-password' : 'new-password'} />
            {mode === 'register' && <span className="muted small" style={{ fontWeight: 400 }}>At least 8 characters.</span>}
          </label>
          {error && <div className="error-box" role="alert">{error}</div>}
          <button className="btn primary" disabled={busy} type="submit">{busy ? 'Please wait…' : mode === 'login' ? 'Sign in' : 'Create account'}</button>
          <button type="button" className="btn ghost" onClick={() => { setMode(mode === 'login' ? 'register' : 'login'); setError(''); }}>
            {mode === 'login' ? 'New here? Create an account' : 'Already have an account? Sign in'}
          </button>
        </form>
      </section>
    </div>
  );
}
