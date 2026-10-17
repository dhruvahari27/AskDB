import type { AgentMode, AnswerPayload, Candidate, Clarification, RunEvent, Usage } from '@askdb/shared/schemas';

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export async function api<T = any>(path: string, opts: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method: opts.method ?? (opts.body !== undefined ? 'POST' : 'GET'),
    headers: opts.body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    credentials: 'same-origin',
  });
  let json: any = null;
  try {
    json = await res.json();
  } catch {
    /* empty body */
  }
  if (!res.ok) {
    // A session that expired (or was cleared) while the page was open: send the user back to the sign-in screen.
    if (res.status === 401 && !path.startsWith('/auth/')) window.dispatchEvent(new Event('askdb:unauthorized'));
    throw new ApiError(res.status, json?.error ?? `Request failed (${res.status})`);
  }
  return json as T;
}

export interface User {
  id: string;
  email: string;
  name?: string | null;
  role: 'admin' | 'user';
}

export interface ConversationSummary {
  id: string;
  title: string;
  mode: AgentMode;
  updatedAt: string;
  questionCount: number;
}

export type StoredResult =
  | { kind: 'answer'; answer: AnswerPayload; trace?: RunEvent[] }
  | { kind: 'clarification'; clarification: Clarification; trace?: RunEvent[] }
  | { kind: 'error'; message: string; trace?: RunEvent[] };

export interface StoredMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  status: 'running' | 'awaiting_clarification' | 'complete' | 'failed' | null;
  runId: string | null;
  result: StoredResult | null;
  createdAt: string;
  feedbackRating: number | null;
  correctedSql: string | null;
}

export interface GlossaryTerm {
  id: string;
  term: string;
  definition: string;
  sqlSnippet: string | null;
  status: 'proposed' | 'approved' | 'rejected';
  source: string;
  createdAt: string;
  createdByEmail: string | null;
  approvedByEmail: string | null;
}

export type { Candidate, Usage, RunEvent, AnswerPayload, Clarification, AgentMode };

/** Subscribe to a run's event stream; reconnects with ?after=<last id> if the connection drops. */
export function streamRun(runId: string, onEvent: (e: RunEvent) => void, onEnd: () => void): () => void {
  let last = -1;
  let closed = false;
  let es: EventSource | null = null;
  let retries = 0;

  const open = () => {
    es = new EventSource(`/api/runs/${runId}/stream${last >= 0 ? `?after=${last}` : ''}`, { withCredentials: true });
    es.onmessage = (m) => {
      retries = 0;
      const e = JSON.parse(m.data) as RunEvent & { i: number };
      last = e.i;
      onEvent(e);
      if (e.type === 'done') {
        closed = true;
        es?.close();
        onEnd();
      }
    };
    es.onerror = () => {
      es?.close();
      if (closed) return;
      if (++retries > 6) {
        closed = true;
        onEnd();
        return;
      }
      setTimeout(() => !closed && open(), Math.min(4000, 400 * retries));
    };
  };
  open();
  return () => {
    closed = true;
    es?.close();
  };
}
