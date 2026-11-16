import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { runDetached, stats, untilScanAborted } from './scanStats.js';

// External HTTP responses go through here.
//
// Live mode: answers live in a bounded in-memory LRU with a per-namespace TTL. Nothing is written to disk
// unless CACHE_WRITE_DISK=1 (developers recording snapshots). Identical concurrent lookups share one request.
// If the network fails, a saved copy beats no answer: committed data/snapshots (labelled "saved demo data")
// and .cache files younger than 7 days; the scan says so in its notes.
// Offline mode (OFFLINE=1) replays data/snapshots and .cache with no age limit and never fetches.
const ROOT = path.resolve(import.meta.dirname, '../..');
const SNAPSHOT_DIR = path.join(ROOT, 'data', 'snapshots');
const cacheDir = () => process.env.CACHE_DIR || path.join(ROOT, '.cache'); // CACHE_DIR: for checks

const HOUR = 3_600_000;
const TTL_MS: Record<string, number> = {
  'osv-query': 6 * HOUR,
  'osv-vuln': 6 * HOUR,
  epss: 24 * HOUR,
  'npm-registry': 1 * HOUR,
  'gemini-package': 24 * HOUR,
};
const DEFAULT_TTL_MS = 1 * HOUR;
const MAX_SAVED_AGE_MS = 7 * 24 * HOUR;

/** Tunables and a clock, exposed so checks can run without waiting. */
// maxBytes bounds memory: OSV advisories can be tens of KB each, so an entry count alone is not enough.
export const cacheConfig = { maxEntries: 20_000, maxBytes: (Number(process.env.CACHE_MAX_MB) || 128) * 1024 * 1024, now: () => Date.now() };

export const isOffline = () => process.env.OFFLINE === '1';

export class OfflineMissError extends Error {
  constructor(namespace: string, key: string) {
    super(`Offline mode: no snapshot for ${namespace}/${key}`);
  }
}

// ---------- in-memory LRU ----------

const memory = new Map<string, { value: unknown; expires: number; bytes: number }>(); // Map order = recency (oldest first)
let memoryBytes = 0;

function memDelete(mk: string) {
  const e = memory.get(mk);
  if (!e) return;
  memoryBytes -= e.bytes;
  memory.delete(mk);
}

/** Rough size in bytes (UTF-16 chars of the JSON); unserialisable values count as small. */
function sizeOf(value: unknown): number {
  try {
    return (JSON.stringify(value)?.length ?? 16) * 2;
  } catch {
    return 1024;
  }
}
const inflight = new Map<string, Promise<Outcome<unknown>>>();
const memKey = (ns: string, key: string) => `${ns}\0${key}`;

function memGet<T>(mk: string): { value: T } | undefined {
  const e = memory.get(mk);
  if (!e) return undefined;
  if (e.expires <= cacheConfig.now()) {
    memDelete(mk);
    return undefined;
  }
  memory.delete(mk); // refresh recency
  memory.set(mk, e);
  return { value: e.value as T };
}

function memSet(ns: string, mk: string, value: unknown) {
  memDelete(mk);
  const bytes = sizeOf(value);
  if (bytes > cacheConfig.maxBytes / 4) return; // one huge answer must not flush everything else
  memory.set(mk, { value, expires: cacheConfig.now() + (TTL_MS[ns] ?? DEFAULT_TTL_MS), bytes });
  memoryBytes += bytes;
  while (memory.size > cacheConfig.maxEntries || memoryBytes > cacheConfig.maxBytes) memDelete(memory.keys().next().value!);
}

export const memorySize = () => memory.size;
export const memoryUsedBytes = () => memoryBytes;
export function clearMemoryCache() {
  memory.clear();
  memoryBytes = 0;
  inflight.clear();
}

// ---------- disk (snapshots, .cache) ----------

function fileFor(dir: string, namespace: string, key: string) {
  const hash = createHash('sha256').update(key).digest('hex').slice(0, 32);
  return path.join(dir, namespace, `${hash}.json`);
}

async function readJson<T>(file: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as T;
  } catch {
    return undefined;
  }
}

interface Saved<T> {
  value: T;
  source: 'demo' | 'cache';
  ageMs: number;
}

async function saved<T>(namespace: string, key: string, maxAgeMs: number): Promise<Saved<T> | undefined> {
  const demo = await readJson<{ value: T }>(fileFor(SNAPSHOT_DIR, namespace, key));
  if (demo) return { value: demo.value, source: 'demo', ageMs: 0 };
  const file = fileFor(cacheDir(), namespace, key);
  const hit = await readJson<{ value: T }>(file);
  if (!hit) return undefined;
  const ageMs = cacheConfig.now() - (await stat(file)).mtimeMs;
  return ageMs <= maxAgeMs ? { value: hit.value, source: 'cache', ageMs } : undefined;
}

let diskWarned = false;
async function writeDisk(namespace: string, key: string, value: unknown) {
  const file = fileFor(cacheDir(), namespace, key);
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(tmp, JSON.stringify({ key, value }));
    await rename(tmp, file); // atomic: readers never see a half-written file
  } catch (e) {
    await rm(tmp, { force: true }).catch(() => {});
    if (!diskWarned) {
      diskWarned = true;
      console.warn(`[cache] could not write ${cacheDir()} (${e instanceof Error ? e.message : String(e)}); continuing without disk copies`);
    }
  }
}

// ---------- cached() ----------

type Outcome<T> = { value: T; fromSaved?: Saved<T> };

/** Counted per caller, so each scan sees its own fallbacks even when the request was shared. */
function countSaved(f: Saved<unknown>) {
  const s = stats();
  if (f.source === 'demo') s.savedFromDemo++;
  else {
    s.savedFromCache++;
    s.oldestSavedMs = Math.max(s.oldestSavedMs, f.ageMs);
  }
}

async function put(namespace: string, key: string, value: unknown) {
  memSet(namespace, memKey(namespace, key), value);
  if (process.env.CACHE_WRITE_DISK === '1') await writeDisk(namespace, key, value);
}

/** Look up only; never fetches. Offline: the saved copy or OfflineMissError. Live: a fresh in-memory answer or undefined. */
export async function peek<T>(namespace: string, key: string): Promise<T | undefined> {
  if (isOffline()) {
    const hit = await saved<T>(namespace, key, Infinity);
    if (hit) return hit.value;
    throw new OfflineMissError(namespace, key);
  }
  return memGet<T>(memKey(namespace, key))?.value;
}

/** Store an answer obtained by the caller (same rules as cached(): memory, plus disk only when CACHE_WRITE_DISK=1). */
export async function store(namespace: string, key: string, value: unknown): Promise<void> {
  if (!isOffline()) await put(namespace, key, value);
}

/** After a network failure: a saved copy if one exists (counted for the scan), else rethrow the failure. */
export async function savedOrThrow<T>(namespace: string, key: string, err: unknown): Promise<T> {
  const fallback = await saved<T>(namespace, key, isOffline() ? Infinity : MAX_SAVED_AGE_MS);
  if (!fallback) throw err;
  countSaved(fallback);
  return fallback.value;
}

export async function cached<T>(namespace: string, key: string, fetcher: () => Promise<T>): Promise<T> {
  const hit = await peek<T>(namespace, key);
  if (hit !== undefined) return hit;
  if (isOffline()) throw new OfflineMissError(namespace, key); // unreachable: peek threw

  // Identical concurrent lookups share one request (and one fallback decision).
  const mk = memKey(namespace, key);
  let pending = inflight.get(mk) as Promise<Outcome<T>> | undefined;
  if (!pending) {
    // Shared by every scan asking for this key, so it runs outside the first caller's scan context:
    // that scan being cancelled must not fail the lookup for the others.
    pending = runDetached(async (): Promise<Outcome<T>> => {
      try {
        const value = await fetcher();
        await put(namespace, key, value);
        return { value };
      } catch (e) {
        const fallback = await saved<T>(namespace, key, MAX_SAVED_AGE_MS);
        if (!fallback) throw e;
        return { value: fallback.value, fromSaved: fallback };
      }
    }).finally(() => inflight.delete(mk));
    pending.catch(() => {}); // every waiter may have stopped waiting
    inflight.set(mk, pending);
  }

  const out = await untilScanAborted(pending);
  if (out.fromSaved) countSaved(out.fromSaved);
  return out.value;
}
