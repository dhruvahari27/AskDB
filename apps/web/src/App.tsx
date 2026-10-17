import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { Navigate, NavLink, Route, Routes, useNavigate } from 'react-router-dom';
import { api, type User } from './api';
import { Icon } from './ui';
import { LoginPage } from './pages/Login';
import { Dashboard } from './pages/Dashboard';
import { AskPage } from './pages/Ask';
import { GlossaryPage } from './pages/Glossary';
import { SchemaPage } from './pages/Schema';
import { EvalsPage } from './pages/Evals';
import { HelpPage } from './pages/Help';
import { Tour } from './Tour';
import { getFlag, setFlag } from './hints';

interface Session {
  user: User;
  provider: string;
  logout: () => Promise<void>;
}
const SessionCtx = createContext<Session>(null as never);
export const useSession = () => useContext(SessionCtx);

function useTheme() {
  const [theme, setTheme] = useState<'light' | 'dark'>(() => {
    const t = document.documentElement.dataset.theme;
    if (t === 'light' || t === 'dark') return t;
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  });
  const toggle = () => {
    const next = theme === 'dark' ? 'light' : 'dark';
    setTheme(next);
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem('askdb-theme', next); } catch { /* private mode */ }
  };
  return { theme, toggle };
}

export function App() {
  const [session, setSession] = useState<{ user: User; provider: string } | null | undefined>(undefined);
  const navigate = useNavigate();
  const theme = useTheme();
  const [tourOpen, setTourOpen] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setSession(await api('/auth/me'));
    } catch {
      setSession(null);
    }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    if (session && !getFlag(session.user.id, 'tour-done')) setTourOpen(true);
  }, [session?.user.id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const out = () => setSession(null);
    window.addEventListener('askdb:unauthorized', out);
    return () => window.removeEventListener('askdb:unauthorized', out);
  }, []);

  if (session === undefined) return <div style={{ height: '100%', display: 'grid', placeItems: 'center' }}><span className="muted">Loading…</span></div>;
  if (!session) return <LoginPage onDone={refresh} />;

  const ctx: Session = {
    user: session.user,
    provider: session.provider,
    logout: async () => {
      await api('/auth/logout', { method: 'POST', body: {} }).catch(() => {});
      setSession(null);
      navigate('/');
    },
  };
  const link = (to: string, icon: string, label: string) => (
    <NavLink to={to} end={to === '/'} className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`}>
      <Icon name={icon} /> <span className="lbl">{label}</span>
    </NavLink>
  );
  return (
    <SessionCtx.Provider value={ctx}>
      <div className="shell">
        <nav className="side" aria-label="Main">
          <div className="brand"><span className="logo"><Icon name="logo" size={18} /></span> AskDB</div>
          {link('/', 'home', 'Overview')}
          {link('/ask', 'chat', 'Ask')}
          {link('/glossary', 'book', 'Glossary')}
          {link('/schema', 'table', 'Schema')}
          {link('/evals', 'flask', 'Evaluation')}
          {link('/help', 'help', 'Help')}
          <div className="side-foot">
            <div className="row" style={{ gap: 8 }}>
              <button className="btn icon ghost" onClick={() => setTourOpen(true)} aria-label="Welcome tour" title="Replay the welcome tour"><Icon name="help" /></button>
              <button className="btn icon ghost" onClick={theme.toggle} aria-label="Toggle theme" title="Toggle light / dark"><Icon name={theme.theme === 'dark' ? 'sun' : 'moon'} /></button>
              <button className="btn icon ghost" onClick={ctx.logout} aria-label="Sign out" title="Sign out"><Icon name="logout" /></button>
            </div>
            <div className="small muted" style={{ overflow: 'hidden', textOverflow: 'ellipsis' }} title={ctx.user.email}>
              {ctx.user.email}{ctx.user.role === 'admin' && <span className="chip accent" style={{ marginLeft: 6 }}>admin</span>}
            </div>
          </div>
        </nav>
        <main className="main">
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/ask" element={<AskPage />} />
            <Route path="/ask/:id" element={<AskPage />} />
            <Route path="/glossary" element={<GlossaryPage />} />
            <Route path="/schema" element={<SchemaPage />} />
            <Route path="/evals" element={<EvalsPage />} />
            <Route path="/help" element={<HelpPage onTour={() => setTourOpen(true)} />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </main>
      </div>
      {tourOpen && <Tour onClose={() => { setTourOpen(false); setFlag(ctx.user.id, 'tour-done'); }} />}
    </SessionCtx.Provider>
  );
}
