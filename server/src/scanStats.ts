import { AsyncLocalStorage } from 'node:async_hooks';

// Per-scan counters. Each scan runs inside runWithStats(), so concurrent scans never see each other's numbers.
export interface ScanStats {
  /** live lookups answered from saved data because the network failed */
  savedFromDemo: number;
  savedFromCache: number;
  /** age in ms of the oldest saved .cache copy used (0 when none) */
  oldestSavedMs: number;
  /** upgrades left unverified because OSV or npm could not be reached */
  unverifiedByNetwork: number;
  /** package names that are not valid npm names and were not looked up */
  invalidPackages: number;
  /** live Gemini calls started by this scan (saved answers do not count); once any was made, the scan is not refunded */
  geminiCalls: number;
  /** aborted when the scan is cancelled (client gone) or passes its deadline; every wait and fetch should honour it */
  signal?: AbortSignal;
}

const newStats = (): ScanStats => ({ savedFromDemo: 0, savedFromCache: 0, oldestSavedMs: 0, unverifiedByNetwork: 0, invalidPackages: 0, geminiCalls: 0 });

const als = new AsyncLocalStorage<ScanStats>();
const orphan = newStats(); // used only by code running outside any scan (checks, startup)

export function runWithStats<T>(fn: (s: ScanStats) => T, signal?: AbortSignal): T {
  const s = newStats();
  if (signal) s.signal = signal;
  return als.run(s, () => fn(s));
}

export const stats = (): ScanStats => als.getStore() ?? orphan;

/** The current scan's cancel/deadline signal, if any. Combine with a per-request timeout: AbortSignal.any([...]). */
export const currentSignal = (): AbortSignal | undefined => als.getStore()?.signal;

/** A signal that fires on the per-request timeout OR when the current scan is cancelled. */
export function withScanSignal(timeoutMs: number): AbortSignal {
  const t = AbortSignal.timeout(timeoutMs);
  const scan = currentSignal();
  return scan ? AbortSignal.any([t, scan]) : t;
}

/**
 * Run work that several scans may share (one cached lookup serving many scans) outside any scan's context,
 * so one scan being cancelled cannot abort it for the others.
 */
export const runDetached = <T>(fn: () => T): T => als.exit(fn);

/** Wait for shared work, but stop waiting (without stopping the work) if THIS scan is cancelled. */
export function untilScanAborted<T>(work: Promise<T>): Promise<T> {
  const signal = currentSignal();
  if (!signal) return work;
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

/** Throws the scan's abort reason if it was cancelled or ran out of time. */
export function throwIfScanAborted(): void {
  currentSignal()?.throwIfAborted();
}

const age = (ms: number) => {
  const h = ms / 3_600_000;
  return h < 1 ? 'less than an hour old' : h < 36 ? `about ${Math.round(h)} hours old` : `about ${Math.round(h / 24)} days old`;
};

/** The scan note for answers taken from saved data, or null when there were none. */
export function savedDataNote(s: ScanStats): string | null {
  const total = s.savedFromDemo + s.savedFromCache;
  if (total === 0) return null;
  const parts: string[] = [];
  if (s.savedFromDemo) parts.push(`${s.savedFromDemo} from saved demo data (a snapshot shipped with the app, so it may be months old)`);
  if (s.savedFromCache) parts.push(`${s.savedFromCache} from saved copies up to ${age(s.oldestSavedMs)}`);
  return `The network blocked some live lookups, so ${total} ${total === 1 ? 'answer was' : 'answers were'} taken from saved data (${parts.join('; ')}). Results may be older than live data.`;
}

/** Whether a scan that ended without a result (timeout, 5xx) gives its quota back: not once Gemini has been called, because that cost real money. */
export const refundableAfterFailure = (s: Pick<ScanStats, 'geminiCalls'> | undefined): boolean => !s || s.geminiCalls === 0;
