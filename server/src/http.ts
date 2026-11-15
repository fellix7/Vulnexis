import { reasonOf } from './net.js';

// fetch with a timeout per attempt and at most 2 retries on 429 / 5xx / network errors, honouring Retry-After.
export const TIMEOUT_MS = 15_000;
export const MAX_RETRIES = 2;
const MAX_WAIT_MS = 10_000;

/** Milliseconds to wait before retry number `attempt` (0-based): Retry-After if sent, else jittered backoff; capped at 10 s. */
export function retryDelay(attempt: number, retryAfter?: string | null, random = Math.random): number {
  let ms = 0;
  if (retryAfter) {
    const secs = Number(retryAfter);
    ms = Number.isFinite(secs) ? secs * 1000 : Date.parse(retryAfter) - Date.now();
    if (!Number.isFinite(ms) || ms < 0) ms = 0;
  }
  if (!ms) ms = 500 * 2 ** attempt * (0.5 + random()); // 250-750 ms, then 500-1500 ms
  return Math.min(ms, MAX_WAIT_MS);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Returns an ok Response. The caller reads the body; pass `read` to read it inside the same timeout. */
export async function fetchRetry<T>(url: string, init: RequestInit | undefined, read: (res: Response) => Promise<T>): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    let wait: string | null | undefined;
    try {
      const res = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (res.ok) return await read(res);
      await res.body?.cancel().catch(() => {});
      lastErr = new Error(`HTTP ${res.status} ${res.statusText}`);
      if (res.status !== 429 && res.status < 500) break; // a real answer such as 404: retrying will not change it
      wait = res.headers.get('retry-after');
    } catch (err) {
      lastErr = err;
    }
    if (attempt < MAX_RETRIES) await sleep(retryDelay(attempt, wait));
  }
  throw new Error(`Request to ${new URL(url).host} failed: ${reasonOf(lastErr)}`, { cause: lastErr });
}
