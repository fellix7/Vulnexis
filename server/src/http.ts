import { reasonOf } from './net.js';
import { currentSignal, withScanSignal } from './scanStats.js';

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

/** Abortable sleep: rejects with the signal's reason as soon as it aborts. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) return new Promise((r) => setTimeout(r, ms));
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const onAbort = () => {
      clearTimeout(t);
      reject(signal.reason);
    };
    const t = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

// ---------- per-host concurrency limit (all scans share it) ----------

export interface HostLimiter {
  /** Resolves with a release function once a slot for `host` is free (FIFO). Rejects, leaving the queue, if `signal` aborts first. */
  acquire(host: string, signal?: AbortSignal): Promise<() => void>;
  inFlight(host: string): number;
  queued(host: string): number;
}

export function createHostLimiter(max: number): HostLimiter {
  const hosts = new Map<string, { active: number; waiters: ((release: () => void) => void)[] }>();
  const state = (h: string) => {
    let s = hosts.get(h);
    if (!s) hosts.set(h, (s = { active: 0, waiters: [] }));
    return s;
  };
  const make = (h: string) => {
    let done = false;
    return () => {
      if (done) return;
      done = true;
      const s = state(h);
      const next = s.waiters.shift();
      if (next) next(make(h)); // hand the slot straight to the oldest waiter
      else if (--s.active === 0) hosts.delete(h);
    };
  };
  return {
    acquire(host, signal) {
      if (signal?.aborted) return Promise.reject(signal.reason);
      const s = state(host);
      if (s.active < max) {
        s.active++;
        return Promise.resolve(make(host));
      }
      return new Promise((resolve, reject) => {
        const waiter = (release: () => void) => {
          signal?.removeEventListener('abort', onAbort);
          resolve(release);
        };
        const onAbort = () => {
          const i = s.waiters.indexOf(waiter);
          if (i >= 0) s.waiters.splice(i, 1);
          reject(signal!.reason);
        };
        s.waiters.push(waiter);
        signal?.addEventListener('abort', onAbort, { once: true });
      });
    },
    inFlight: (h) => hosts.get(h)?.active ?? 0,
    queued: (h) => hosts.get(h)?.waiters.length ?? 0,
  };
}

export const HTTP_MAX_PER_HOST = Math.max(1, Number(process.env.HTTP_MAX_PER_HOST) || 16);
export const hostLimiter = createHostLimiter(HTTP_MAX_PER_HOST);

/** Returns an ok Response. The caller reads the body; pass `read` to read it inside the same timeout. */
export async function fetchRetry<T>(url: string, init: RequestInit | undefined, read: (res: Response) => Promise<T>): Promise<T> {
  let lastErr: unknown;
  const host = new URL(url).host;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    let wait: string | null | undefined;
    // Waiting for a slot does not count against the request timeout, but a cancelled scan leaves the queue at once.
    const release = await hostLimiter.acquire(host, currentSignal());
    try {
      const res = await fetch(url, { ...init, signal: withScanSignal(TIMEOUT_MS) });
      if (res.ok) return await read(res);
      await res.body?.cancel().catch(() => {});
      lastErr = new Error(`HTTP ${res.status} ${res.statusText}`);
      if (res.status !== 429 && res.status < 500) break; // a real answer such as 404: retrying will not change it
      wait = res.headers.get('retry-after');
    } catch (err) {
      currentSignal()?.throwIfAborted(); // scan cancelled or out of time: never retry
      lastErr = err;
    } finally {
      release();
    }
    if (attempt < MAX_RETRIES) await sleep(retryDelay(attempt, wait), currentSignal());
  }
  throw new Error(`Request to ${host} failed: ${reasonOf(lastErr)}`, { cause: lastErr });
}
