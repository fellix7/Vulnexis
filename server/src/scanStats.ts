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
}

const newStats = (): ScanStats => ({ savedFromDemo: 0, savedFromCache: 0, oldestSavedMs: 0, unverifiedByNetwork: 0, invalidPackages: 0 });

const als = new AsyncLocalStorage<ScanStats>();
const orphan = newStats(); // used only by code running outside any scan (checks, startup)

export function runWithStats<T>(fn: (s: ScanStats) => T): T {
  const s = newStats();
  return als.run(s, () => fn(s));
}

export const stats = (): ScanStats => als.getStore() ?? orphan;

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
