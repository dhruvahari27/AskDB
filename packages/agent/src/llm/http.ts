import { LlmError } from './types';

export interface PostJsonOptions {
  url: string;
  headers: Record<string, string>;
  body: unknown;
  /** how many times to retry rate limits and 5xx responses */
  retries?: number;
  timeoutMs?: number;
  providerName: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** POST JSON with timeout, and retry with exponential backoff on 429 / 5xx (free tiers rate limit hard). */
export async function postJson<T>(opts: PostJsonOptions): Promise<T> {
  const retries = opts.retries ?? 4;
  let lastMessage = '';
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 60_000);
    try {
      const res = await fetch(opts.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...opts.headers },
        body: JSON.stringify(opts.body),
        signal: ctrl.signal,
      });
      if (res.ok) return (await res.json()) as T;

      const text = await res.text().catch(() => '');
      lastMessage = `${opts.providerName} returned HTTP ${res.status}`;
      if (res.status === 401 || res.status === 403) {
        throw new LlmError(`${opts.providerName} rejected the API key (HTTP ${res.status}). Check your .env.`, res.status);
      }
      if (res.status === 400 || res.status === 404) {
        throw new LlmError(`${opts.providerName} rejected the request (HTTP ${res.status}): ${text.slice(0, 300)}`, res.status);
      }
      if (res.status === 429 || res.status >= 500) {
        const retryAfter = Number(res.headers.get('retry-after'));
        const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : Math.min(2 ** attempt * 1000, 15_000);
        if (attempt < retries) {
          await sleep(wait + Math.random() * 250);
          continue;
        }
        throw new LlmError(
          res.status === 429
            ? `${opts.providerName} is rate limiting requests (free tier). Wait a minute and try again.`
            : `${opts.providerName} is having problems (HTTP ${res.status}). Try again shortly.`,
          res.status,
        );
      }
      throw new LlmError(`${lastMessage}: ${text.slice(0, 200)}`, res.status);
    } catch (e) {
      if (e instanceof LlmError) throw e;
      lastMessage = (e as Error).name === 'AbortError' ? `${opts.providerName} timed out` : `Could not reach ${opts.providerName}: ${(e as Error).message}`;
      if (attempt < retries) {
        await sleep(Math.min(2 ** attempt * 1000, 8_000));
        continue;
      }
      throw new LlmError(lastMessage);
    } finally {
      clearTimeout(timer);
    }
  }
  throw new LlmError(lastMessage || 'LLM request failed');
}
