import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { cached, isOffline } from '../cache.js';
import type { Advisory, Enrichment } from '../types.js';

// Adds EPSS (exploit probability, FIRST) and KEV (exploited in the wild, CISA) to advisories.
// Missing data is always null ("no data"), never 0 / false-by-default.

const ROOT = path.resolve(import.meta.dirname, '../../..');
const KEV_FILE = path.join(ROOT, 'data', 'kev.json');
const KEV_URL = 'https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json';
const EPSS_URL = 'https://api.first.org/data/v1/epss';
const EPSS_BATCH = 50;
const FETCH_TIMEOUT_MS = 15_000;

export interface EnrichResult {
  /** keyed by advisory.id */
  map: Map<string, Enrichment>;
  /** non-fatal problems (EPSS unreachable, KEV missing); append to ScanResult.notes */
  warnings: string[];
  /** release date of the KEV catalog that was used, e.g. "2026-10-23" */
  kevDate?: string;
}

// The bundled data/kev.json is loaded once; at most every 24 h the official CISA feed is downloaded to refresh it.
// A failed or malformed download keeps the bundled copy (one log line); the file is replaced only after validation.
const KEV_REFRESH_MS = 24 * 3_600_000;
const kevState: { set?: Set<string>; date?: string; attemptedAt: number; refreshing?: Promise<void> } = { attemptedAt: 0 };

export interface KevCatalog {
  set: Set<string>;
  /** e.g. "2026-10-23" */
  date?: string;
}

/** Returns the parsed catalog, or null when the JSON is not a KEV catalog. */
export function parseKev(text: string): KevCatalog | null {
  let json: { vulnerabilities?: unknown; dateReleased?: unknown; catalogVersion?: unknown };
  try {
    json = JSON.parse(text);
  } catch {
    return null;
  }
  const list = json?.vulnerabilities;
  if (!Array.isArray(list) || list.length < 100) return null; // the real catalog has well over a thousand entries
  const set = new Set<string>();
  for (const v of list) {
    const id = (v as { cveID?: unknown } | null)?.cveID;
    if (typeof id !== 'string' || !/^CVE-\d{4}-\d{4,}$/i.test(id)) return null;
    set.add(id.toUpperCase());
  }
  const released = typeof json.dateReleased === 'string' && /^\d{4}-\d{2}-\d{2}/.test(json.dateReleased) ? json.dateReleased.slice(0, 10) : undefined;
  const version = typeof json.catalogVersion === 'string' ? json.catalogVersion.replace(/\./g, '-') : undefined;
  const date = released ?? version;
  return date ? { set, date } : { set };
}

function adopt(cat: KevCatalog) {
  kevState.set = cat.set;
  kevState.date = cat.date;
}

async function downloadKev(): Promise<void> {
  try {
    const res = await fetch(KEV_URL, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    const cat = parseKev(text);
    if (!cat) throw new Error('the download is not a valid KEV catalog');
    adopt(cat); // usable even if the disk copy below cannot be written
    const tmp = `${KEV_FILE}.${process.pid}.tmp`;
    try {
      await mkdir(path.dirname(KEV_FILE), { recursive: true });
      await writeFile(tmp, text);
      await rename(tmp, KEV_FILE);
    } catch (e) {
      await rm(tmp, { force: true }).catch(() => {});
      console.warn(`[kev] could not save data/kev.json (${e instanceof Error ? e.message : String(e)})`);
    }
    console.log(`[kev] refreshed from CISA (${cat.set.size} entries, ${cat.date ?? 'date unknown'})`);
  } catch (err) {
    console.warn(`[kev] refresh failed (${err instanceof Error ? err.message : String(err)}); using the bundled copy${kevState.date ? ` from ${kevState.date}` : ''}`);
  }
}

/** Starts a download when the catalog has not been tried in the last 24 h. Never throws. */
function refreshKev(): Promise<void> {
  if (isOffline() || kevState.refreshing || Date.now() - kevState.attemptedAt < KEV_REFRESH_MS) return kevState.refreshing ?? Promise.resolve();
  kevState.attemptedAt = Date.now();
  kevState.refreshing = downloadKev().finally(() => {
    kevState.refreshing = undefined;
  });
  return kevState.refreshing;
}

async function readBundledKev(): Promise<boolean> {
  try {
    const cat = parseKev(await readFile(KEV_FILE, 'utf8'));
    if (cat) {
      adopt(cat);
      const age = Date.now() - (await stat(KEV_FILE)).mtimeMs;
      if (age < KEV_REFRESH_MS) kevState.attemptedAt = Date.now() - age; // fresh enough: next try after the 24 h are up
      return true;
    }
  } catch {
    /* missing or unreadable */
  }
  return false;
}

export async function loadKev(): Promise<Set<string>> {
  if (!kevState.set) {
    if (!(await readBundledKev())) {
      if (isOffline()) throw new Error('data/kev.json is missing or invalid and OFFLINE=1');
      await refreshKev(); // nothing to fall back on: wait for the download
      if (!kevState.set) throw new Error('data/kev.json is missing and the CISA download failed');
    }
  }
  void refreshKev(); // stale? refresh in the background so this scan is not delayed; the next one uses it
  return kevState.set!;
}

/** The catalog release date, e.g. "2026-10-23", once loadKev() has run. */
export const kevCatalogDate = (): string | undefined => kevState.date;

export function cveIdsOf(advisory: Pick<Advisory, 'id' | 'aliases'>): string[] {
  const ids = new Set<string>();
  for (const id of [advisory.id, ...advisory.aliases]) {
    if (/^CVE-/i.test(id)) ids.add(id.toUpperCase());
  }
  return [...ids];
}

interface EpssResponse {
  data?: { cve: string; epss: string }[];
}

async function fetchEpssBatch(cves: string[]): Promise<Map<string, number>> {
  const res = await fetch(`${EPSS_URL}?cve=${cves.join(',')}`, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`EPSS HTTP ${res.status}`);
  const body = (await res.json()) as EpssResponse;
  const out = new Map<string, number>();
  for (const row of body.data ?? []) {
    const p = Number(row.epss);
    if (Number.isFinite(p)) out.set(row.cve.toUpperCase(), p);
  }
  return out;
}

// EPSS per CVE, cached per CVE (a CVE FIRST doesn't know is cached as null). A batch of up to
// EPSS_BATCH CVEs is fetched in one request, and only if at least one of its CVEs misses the cache.
async function lookupEpss(cves: string[], warnings: string[]): Promise<Map<string, number | null>> {
  const result = new Map<string, number | null>();
  let failed = 0;
  let firstError = '';

  const tasks: Promise<void>[] = [];
  for (let i = 0; i < cves.length; i += EPSS_BATCH) {
    const chunk = cves.slice(i, i + EPSS_BATCH);
    let batch: Promise<Map<string, number>> | undefined;
    const getBatch = () => (batch ??= fetchEpssBatch(chunk));
    for (const cve of chunk) {
      tasks.push(
        cached<number | null>('epss', cve, async () => (await getBatch()).get(cve) ?? null).then(
          (v) => void result.set(cve, v),
          (err: unknown) => {
            failed++;
            firstError ||= err instanceof Error ? err.message : String(err);
            result.set(cve, null);
          },
        ),
      );
    }
  }
  await Promise.all(tasks);
  if (failed) warnings.push(`EPSS unavailable for ${failed} CVE(s) (${firstError}); shown as "no data"`);
  return result;
}

/** Never throws for network problems; they become `warnings` and null ("no data") values. */
export async function enrich(advisories: Advisory[]): Promise<EnrichResult> {
  const warnings: string[] = [];
  const map = new Map<string, Enrichment>();

  let kev: Set<string> | null = null;
  try {
    kev = await loadKev();
  } catch (err) {
    warnings.push(`CISA KEV list unavailable (${err instanceof Error ? err.message : String(err)}); KEV shown as "no data"`);
  }

  const cvesByAdvisory = new Map<string, string[]>(advisories.map((a) => [a.id, cveIdsOf(a)]));
  const allCves = [...new Set([...cvesByAdvisory.values()].flat())];
  const epss = allCves.length ? await lookupEpss(allCves, warnings) : new Map<string, number | null>();

  for (const a of advisories) {
    const cves = cvesByAdvisory.get(a.id) ?? [];
    if (cves.length === 0) {
      map.set(a.id, { epss: null, kev: null });
      continue;
    }
    const scores = cves.map((c) => epss.get(c)).filter((v): v is number => typeof v === 'number');
    map.set(a.id, {
      epss: scores.length ? Math.max(...scores) : null,
      kev: kev ? cves.some((c) => kev.has(c)) : null,
    });
  }
  const kevDate = kev ? kevCatalogDate() : undefined;
  return kevDate ? { map, warnings, kevDate } : { map, warnings };
}
