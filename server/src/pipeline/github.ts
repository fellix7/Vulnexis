import { Readable, Transform, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';
import { adviceFor, reasonOf } from '../net.js';
import { currentSignal, withScanSignal } from '../scanStats.js';
import type { RepoRef, SourceFile } from '../types.js';
import { isContextPath, MAX_CONTEXT_FILE_BYTES, MAX_CONTEXT_FILES, MAX_CONTEXT_TOTAL_BYTES } from './context.js';

// Reads a PUBLIC GitHub repository: its package-lock.json and the JavaScript/TypeScript source that the
// AI code check needs. Files are only downloaded as text; nothing is cloned, installed or executed.
// One anonymous tarball download per scan: no API key and no API rate limit.

const SOURCE_EXT = /\.(js|jsx|ts|tsx|mjs|cjs)$/;
const SKIP_DIR = /(^|\/)(node_modules|dist|build|out|coverage|vendor|\.next|\.nuxt|\.git|public\/assets)(\/|$)/;
const SKIP_FILE = /(\.min\.js|\.d\.ts|\.test\.[jt]sx?|\.spec\.[jt]sx?)$/;
const MAX_SOURCE_FILES = 120;
const MAX_FILE_BYTES = 200_000;
const MAX_TOTAL_BYTES = 3 * 1024 * 1024;
const MAX_LOCKFILE_BYTES = 10 * 1024 * 1024;
const TIMEOUT_MS = 15_000;

export class RepoError extends Error {}

const MAX_URL_CHARS = 300;
const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO_RE = /^[A-Za-z0-9._-]{1,100}$/;
const REF_RE = /^[A-Za-z0-9._/-]{1,200}$/;
const MAX_TAR_ENTRIES = 50_000;
const MAX_KEPT_BYTES = 48 * 1024 * 1024; // sources + context files held at once
const MAX_KEPT_LOCK_BYTES = 24 * 1024 * 1024;
const CODE_EXT = /\.(js|jsx|ts|tsx|mjs|cjs|mts|cts|vue|svelte)$/;

/** Encode a ref segment by segment so slashes in branch names survive. */
const encRef = (ref: string) => ref.split('/').map(encodeURIComponent).join('/');

function checkParts(owner: string, name: string, ref?: string): void {
  if (!OWNER_RE.test(owner) || !REPO_RE.test(name) || name === '.' || name === '..') {
    throw new RepoError('That is not a valid GitHub owner/repository name. Paste something like https://github.com/owner/repo.');
  }
  if (ref !== undefined && (!REF_RE.test(ref) || ref.split('/').some((seg) => seg === '..'))) {
    throw new RepoError('That branch or tag name is not valid. Use a plain name such as https://github.com/owner/repo/tree/main.');
  }
}

export function parseRepoUrl(raw: string): { owner: string; name: string; ref?: string } {
  if (raw.length > MAX_URL_CHARS) throw new RepoError(`That link is too long (over ${MAX_URL_CHARS} characters). Paste something like https://github.com/owner/repo.`);
  let s = raw.trim();
  let end = s.length;
  while (end > 0 && s[end - 1] === '/') end--;
  s = s.slice(0, end).replace(/\.git$/, '');
  const short = s.match(/^([\w.-]+)\/([\w.-]+)$/);
  if (short) {
    checkParts(short[1]!, short[2]!);
    return { owner: short[1]!, name: short[2]! };
  }
  let url: URL;
  try {
    url = new URL(/^https?:\/\//.test(s) ? s : `https://${s}`);
  } catch {
    throw new RepoError('That does not look like a GitHub link. Paste something like https://github.com/owner/repo.');
  }
  if (url.hostname !== 'github.com' && url.hostname !== 'www.github.com') {
    throw new RepoError('Only public github.com repositories are supported.');
  }
  const [owner, name, kind, ...rest] = url.pathname.split('/').filter(Boolean);
  if (!owner || !name) throw new RepoError('The link needs both the owner and the repository name: https://github.com/owner/repo.');
  const ref = kind === 'tree' && rest.length ? rest.join('/') : undefined;
  checkParts(owner, name, ref);
  return { owner, name, ref };
}

const MAX_TARBALL_BYTES = 60 * 1024 * 1024;
const MAX_UNPACKED_BYTES = 300 * 1024 * 1024;

const FIRST_BYTE_MS = 20_000; // GitHub must start answering within this
const DOWNLOAD_MS = 120_000; // the whole tarball, on a slow venue Wi-Fi

/** A network failure (as opposed to GitHub answering with an error), with the low-level reason kept. */
class NetworkError extends RepoError {
  constructor(readonly reason: string) {
    super(networkMessage(reason));
  }
}

export function networkMessage(reason: string): string {
  return `Could not download the repository from GitHub. ${adviceFor(reason)} Try again, or upload the lockfile instead. (${reason})`;
}

/** GET with a first-byte deadline and an overall deadline; one retry on network failure. A cancelled scan is never retried. */
async function getWithDeadlines<T>(url: string, hosts: string[], read: (res: Response) => Promise<T>): Promise<{ res: Response; body: T | undefined }> {
  let last: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    const ctrl = new AbortController();
    const timeout = () => ctrl.abort(new DOMException('timed out', 'TimeoutError'));
    const first = setTimeout(timeout, FIRST_BYTE_MS);
    const total = setTimeout(timeout, DOWNLOAD_MS);
    const scan = currentSignal();
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'vulnera-scanner' }, signal: scan ? AbortSignal.any([ctrl.signal, scan]) : ctrl.signal, redirect: 'follow' });
      clearTimeout(first);
      if (res.url && !hosts.includes(new URL(res.url).hostname)) {
        await res.body?.cancel().catch(() => {});
        throw new RepoError('GitHub redirected the download to an unexpected address, so it was not used.');
      }
      return { res, body: res.ok ? await read(res) : undefined };
    } catch (e) {
      scan?.throwIfAborted();
      if (e instanceof RepoError) throw e;
      last = e;
      console.warn(`[github] ${url} attempt ${attempt + 1} failed: ${reasonOf(e)}`);
    } finally {
      clearTimeout(first);
      clearTimeout(total);
    }
  }
  throw new NetworkError(reasonOf(last));
}

const capped = (max: number, message: string) => async (res: Response): Promise<Buffer> => {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of res.body as unknown as AsyncIterable<Uint8Array>) {
    size += c.length;
    if (size > max) throw new RepoError(message);
    chunks.push(Buffer.from(c));
  }
  return Buffer.concat(chunks);
};
const readCappedLockfile = capped(MAX_LOCKFILE_BYTES, 'The package-lock.json in this repository is larger than 10 MB. Upload a smaller lockfile instead.');

const TOO_BIG_COMPRESSED = 'This repository is larger than 60 MB. Upload its package-lock.json instead.';
const TOO_BIG_UNPACKED = 'This repository is too large to read (over 300 MB unpacked). Upload its package-lock.json instead.';
const STOP = new Error('tar reading finished'); // ends the pipeline early without being a failure

/** Streams the body through gunzip and the tar parser; only the kept files are held in memory. Stops the download at any cap. */
async function readTarball(res: Response, keep: (path: string, size: number) => boolean): Promise<TarResult> {
  const parser = new TarParser(keep);
  let compressed = 0;
  let unpacked = 0;
  const count = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      compressed += chunk.length;
      cb(compressed > MAX_TARBALL_BYTES ? new RepoError(TOO_BIG_COMPRESSED) : null, chunk);
    },
  });
  const sink = new Writable({
    write(chunk: Buffer, _enc, cb) {
      unpacked += chunk.length;
      if (unpacked > MAX_UNPACKED_BYTES) return cb(new RepoError(TOO_BIG_UNPACKED));
      try {
        parser.push(chunk);
      } catch (e) {
        return cb(e as Error);
      }
      cb(parser.done ? STOP : null);
    },
  });
  try {
    await pipeline(Readable.fromWeb(res.body as never), count, createGunzip(), sink);
  } catch (e) {
    if (e !== STOP) {
      if (typeof (e as NodeJS.ErrnoException)?.code === 'string' && (e as NodeJS.ErrnoException).code!.startsWith('Z_')) {
        throw new RepoError('GitHub sent an archive that could not be unpacked. Try again, or upload the lockfile instead.');
      }
      throw e;
    }
  }
  return parser.finish();
}

// One download per scan: the repository snapshot from codeload (no API quota, no token, public repos only).
// Streamed: gunzip + tar run as the bytes arrive, so memory stays near the size of the kept files.
async function download(owner: string, name: string, ref: string, keep: (path: string, size: number) => boolean): Promise<TarResult> {
  const url = `https://codeload.github.com/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/tar.gz/${encRef(ref)}`;
  const { res, body } = await getWithDeadlines(url, ['codeload.github.com', 'github.com'], (r) => readTarball(r, keep));
  if (res.status === 404) throw new RepoError('Repository not found. Check the link, and make sure the repository is public.');
  if (res.status === 403 || res.status === 429) throw new NetworkError(`HTTP ${res.status} from codeload.github.com`);
  if (!res.ok || !body) throw new RepoError(`GitHub answered HTTP ${res.status}.`);
  return body;
}

/**
 * Fallback when the repository download fails: read only the root package-lock.json from
 * raw.githubusercontent.com. The scan still runs; the code check is skipped (no source files).
 */
async function rootLockfile(owner: string, name: string, ref: string): Promise<unknown | null> {
  const url = `https://raw.githubusercontent.com/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/${encRef(ref)}/package-lock.json`;
  const { res, body } = await getWithDeadlines(url, ['raw.githubusercontent.com', 'github.com'], readCappedLockfile);
  if (res.status === 404) return null;
  if (!res.ok) throw new NetworkError(`HTTP ${res.status} from raw.githubusercontent.com`);
  try {
    return JSON.parse(body!.toString('utf8'));
  } catch {
    throw new RepoError('package-lock.json in this repository is not valid JSON.');
  }
}

interface TarFile {
  path: string; // without the top-level "<repo>-<sha>/" folder
  data: Buffer;
}
export interface TarResult {
  files: TarFile[];
  all: { path: string; size: number }[];
  truncated: boolean;
}

const MAX_META_BYTES = 64 * 1024; // GNU long names / PAX headers larger than this are ignored

/**
 * Incremental ustar reader: regular files only, with GNU long names and PAX path headers. Feed it chunks with push();
 * it copies only the files `keep` wants and records path + size for every regular file. `done` turns true at the end
 * of the archive or when the entry cap is hit (truncated).
 */
export class TarParser {
  readonly files: TarFile[] = [];
  readonly all: { path: string; size: number }[] = [];
  truncated = false;
  done = false;
  private hdr = Buffer.alloc(512);
  private hdrFill = 0;
  private entries = 0;
  private longName: string | null = null;
  private cur: { mode: 'keep' | 'meta' | 'skip'; type: string; name: string; remaining: number; pad: number; chunks: Buffer[] } | null = null;

  constructor(private keep: (path: string, size: number) => boolean) {}

  push(chunk: Uint8Array): void {
    let off = 0;
    while (off < chunk.length && !this.done) {
      const cur = this.cur;
      if (!cur) {
        const take = Math.min(512 - this.hdrFill, chunk.length - off);
        this.hdr.set(chunk.subarray(off, off + take), this.hdrFill);
        this.hdrFill += take;
        off += take;
        if (this.hdrFill === 512) {
          this.hdrFill = 0;
          this.start();
        }
      } else if (cur.remaining > 0) {
        const take = Math.min(cur.remaining, chunk.length - off);
        if (cur.mode !== 'skip') cur.chunks.push(Buffer.from(chunk.subarray(off, off + take))); // copy: do not pin zlib's buffers
        cur.remaining -= take;
        off += take;
        if (cur.remaining === 0 && cur.pad === 0) this.end();
      } else {
        const take = Math.min(cur.pad, chunk.length - off);
        cur.pad -= take;
        off += take;
        if (cur.pad === 0) this.end();
      }
    }
  }

  private start(): void {
    const h = this.hdr;
    if (h[0] === 0) {
      this.done = true;
      return;
    }
    if (++this.entries > MAX_TAR_ENTRIES) {
      this.truncated = true;
      this.done = true;
      return;
    }
    const str = (a: number, n: number) => h.toString('utf8', a, a + n).replace(/\0.*$/s, '');
    const size = parseInt(str(124, 12).trim() || '0', 8);
    if (!Number.isFinite(size) || size < 0) {
      this.done = true; // corrupt header: never loop on it
      return;
    }
    const type = String.fromCharCode(h[156] || 48);
    const prefix = str(345, 155);
    let name = this.longName ?? (prefix ? `${prefix}/${str(0, 100)}` : str(0, 100));
    this.longName = null;
    let mode: 'keep' | 'meta' | 'skip' = 'skip';
    if (type === 'L' || type === 'x') mode = size <= MAX_META_BYTES ? 'meta' : 'skip';
    else if (type === '0' || type === '7') {
      name = name.replace(/^[^/]*\//, '');
      this.all.push({ path: name, size });
      if (this.keep(name, size)) mode = 'keep';
    }
    this.cur = { mode, type, name, remaining: size, pad: Math.ceil(size / 512) * 512 - size, chunks: [] };
    if (size === 0 && this.cur.pad === 0) this.end();
  }

  private end(): void {
    const c = this.cur!;
    this.cur = null;
    if (c.mode === 'keep') this.files.push({ path: c.name, data: Buffer.concat(c.chunks) });
    else if (c.mode === 'meta') {
      const text = Buffer.concat(c.chunks).toString('utf8');
      if (c.type === 'L') this.longName = text.replace(/\0.*$/s, '');
      else {
        const m = text.match(/\d+ path=([^\n]*)\n/);
        if (m) this.longName = m[1]!;
      }
    }
  }

  /** Call after the last push (a half-read kept file is returned as far as it got, like a cut-off archive). */
  finish(): TarResult {
    if (this.cur?.mode === 'keep') this.files.push({ path: this.cur.name, data: Buffer.concat(this.cur.chunks) });
    this.cur = null;
    return { files: this.files, all: this.all, truncated: this.truncated };
  }
}

/** Whole-buffer convenience over TarParser (used by checks). */
export function untar(buf: Buffer, keep: (path: string, size: number) => boolean): TarResult {
  const p = new TarParser(keep);
  p.push(buf);
  return p.finish();
}

export interface FetchedRepo {
  repo: RepoRef;
  lockfile: unknown;
  sources: SourceFile[];
  contextFiles: SourceFile[]; // deployment/architecture files, paths relative to the repository root
  base: string; // folder of the lockfile ('' at the root, else "app/"); source paths are relative to it
  skipped: number; // source files not read because of the limits above
  sourceFilesFound: number;
  truncated?: boolean; // the archive had more than 50,000 entries; the rest were not read
  fallback?: string; // set when only the root lockfile could be read, with the reason
}

/**
 * Stars and contributor count from the GitHub API (one small request each, in parallel with the download).
 * Optional: unauthenticated calls allow 60 an hour per IP (GITHUB_TOKEN raises that); any failure just leaves them out.
 */
type RepoStats = { stars?: number; contributors?: number };
const STATS_TTL_MS = 3_600_000; // GitHub allows 60 anonymous API calls an hour per IP: remember answers for an hour
const STATS_EMPTY_TTL_MS = 300_000; // a failed lookup (rate limit, network) is retried after 5 minutes
const STATS_MAX = 1000;
const statsCache = new Map<string, { at: number; ttl: number; value: Promise<RepoStats> }>();
/** For checks. */
export const clearRepoStatsCache = () => statsCache.clear();

async function loadRepoStats(owner: string, name: string): Promise<{ stars?: number; contributors?: number }> {
  const headers: Record<string, string> = { 'User-Agent': 'vulnera-scanner', Accept: 'application/vnd.github+json' };
  if (process.env.GITHUB_TOKEN?.trim()) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN.trim()}`;
  const base = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
  const get = async (url: string) => {
    const r = await fetch(url, { headers, signal: withScanSignal(8000) });
    if (r.url && new URL(r.url).hostname !== 'api.github.com') throw new Error('unexpected redirect');
    return r;
  };
  const [repo, people] = await Promise.allSettled([
    get(base).then(async (r) => (r.ok ? ((await r.json()) as { stargazers_count?: unknown }).stargazers_count : undefined)),
    get(`${base}/contributors?per_page=1`).then(async (r) => {
      if (!r.ok) return undefined;
      // With per_page=1 the page number of rel="last" is the contributor count.
      const last = r.headers.get('link')?.match(/[?&]page=(\d+)>;\s*rel="last"/);
      if (last) return Number(last[1]);
      const list = (await r.json()) as unknown[];
      return Array.isArray(list) ? list.length : undefined;
    }),
  ]);
  currentSignal()?.throwIfAborted();
  const out: RepoStats = {};
  if (repo.status === 'fulfilled' && typeof repo.value === 'number') out.stars = repo.value;
  if (people.status === 'fulfilled' && typeof people.value === 'number' && Number.isFinite(people.value)) out.contributors = people.value;
  return out;
}

/**
 * Stars and contributor count from the GitHub API (two small requests, shared by every scan of the same repository for an hour).
 * Optional: any failure just leaves them out. A scan that is cancelled gets the abort, and nothing is cached from it.
 */
export function fetchRepoStats(owner: string, name: string): Promise<RepoStats> {
  const key = `${owner}/${name}`.toLowerCase();
  const hit = statsCache.get(key);
  if (hit && Date.now() - hit.at < hit.ttl) return hit.value;
  const entry = { at: Date.now(), ttl: STATS_TTL_MS, value: loadRepoStats(owner, name) };
  statsCache.delete(key);
  statsCache.set(key, entry);
  if (statsCache.size > STATS_MAX) statsCache.delete(statsCache.keys().next().value!);
  entry.value.then(
    (v) => {
      if (Object.keys(v).length === 0) entry.ttl = STATS_EMPTY_TTL_MS;
    },
    () => {
      if (statsCache.get(key) === entry) statsCache.delete(key);
    },
  );
  return entry.value;
}

export async function fetchRepo(rawUrl: string): Promise<FetchedRepo> {
  const { owner, name, ref: askedRef } = parseRepoUrl(rawUrl);
  const ref = askedRef ?? 'HEAD';
  const statsPromise = fetchRepoStats(owner, name).catch(() => ({}));
  const isLock = (p: string) => /(^|\/)(package-lock|npm-shrinkwrap)\.json$/.test(p) && !SKIP_DIR.test(p);
  const isSource = (p: string, size: number) => SOURCE_EXT.test(p) && !SKIP_DIR.test(p) && !SKIP_FILE.test(p) && size <= MAX_FILE_BYTES;
  const isContext = (p: string, size: number) => isContextPath(p) && size <= MAX_CONTEXT_FILE_BYTES;
  // Only these files are held in memory while the archive streams past; the rest is just counted.
  let keptLock = 0;
  let keptOther = 0;
  let overflow = false;
  const keep = (p: string, size: number) => {
    if (isLock(p) && size <= MAX_LOCKFILE_BYTES) {
      if (keptLock + size > MAX_KEPT_LOCK_BYTES) return (overflow = true), false;
      keptLock += size;
      return true;
    }
    if (isSource(p, size) || isContext(p, size)) {
      if (keptOther + size > MAX_KEPT_BYTES) return (overflow = true), false;
      keptOther += size;
      return true;
    }
    return false;
  };
  let tar: TarResult;
  try {
    tar = await download(owner, name, ref, keep);
  } catch (e) {
    if (!(e instanceof NetworkError)) throw e;
    // The full download failed on this network: fall back to the root lockfile alone.
    const lockfile = await rootLockfile(owner, name, ref).catch((e2) => {
      throw e2 instanceof NetworkError ? e : e2;
    });
    if (lockfile === null) {
      throw new RepoError(`${e.message.replace(/ Try again.*$/, '')} The fallback found no package-lock.json at the repository root either. Upload the lockfile instead.`);
    }
    return {
      repo: { owner, name, ref: askedRef ?? 'default branch', url: `https://github.com/${owner}/${name}`, lockfilePath: 'package-lock.json', sourceFiles: 0, ...(await statsPromise) },
      lockfile,
      sources: [],
      contextFiles: [],
      base: '',
      skipped: 0,
      sourceFilesFound: 0,
      fallback: e.reason,
    };
  }

  const { files, all } = tar;
  const truncated = tar.truncated || overflow;

  // Shallowest lockfile wins (monorepos keep it at the root).
  const lockEntry = files.filter((f) => isLock(f.path)).sort((a, b) => a.path.split('/').length - b.path.split('/').length)[0];
  if (!lockEntry) {
    const hasYarn = all.some((b) => /(^|\/)(yarn\.lock|pnpm-lock\.yaml)$/.test(b.path));
    throw new RepoError(
      hasYarn
        ? 'This repository uses Yarn or pnpm. Vulnera currently reads npm lockfiles (package-lock.json) only.'
        : 'No package-lock.json found in this repository. Vulnera needs an npm lockfile to know exact versions.',
    );
  }
  let lockfile: unknown;
  try {
    lockfile = JSON.parse(lockEntry.data.toString('utf8'));
  } catch {
    throw new RepoError(`${lockEntry.path} is not valid JSON.`);
  }

  // Source files next to the lockfile (same project), shallow paths first so app code beats deep folders.
  const base = lockEntry.path.includes('/') ? lockEntry.path.slice(0, lockEntry.path.lastIndexOf('/') + 1) : '';
  const candidates = files
    .filter((f) => f.path.startsWith(base) && isSource(f.path, f.data.length))
    .sort((a, b) => a.path.split('/').length - b.path.split('/').length || a.path.localeCompare(b.path));
  // Code-looking files that were left out (too big, or a type we do not read): the picture is incomplete.
  let droppedCode = truncated ? 1 : 0;
  for (const f of all) {
    if (f.path.startsWith(base) && CODE_EXT.test(f.path) && !SKIP_DIR.test(f.path) && !SKIP_FILE.test(f.path) && (f.size > MAX_FILE_BYTES || !SOURCE_EXT.test(f.path))) droppedCode++;
  }
  const sources: SourceFile[] = [];
  let total = 0;
  for (const c of candidates) {
    if (sources.length >= MAX_SOURCE_FILES || total + c.data.length > MAX_TOTAL_BYTES) break;
    sources.push({ path: c.path.slice(base.length), content: c.data.toString('utf8') });
    total += c.data.length;
  }

  // Architecture files anywhere in the repository (compose files often sit above the app folder):
  // deployment files first, then docs, shallow paths first.
  const docRank = (p: string) => (/\.md$/i.test(p) ? 1 : 0);
  const contextFiles: SourceFile[] = [];
  let contextBytes = 0;
  for (const c of files
    .filter((f) => isContext(f.path, f.data.length) && !isLock(f.path))
    .sort((a, b) => docRank(a.path) - docRank(b.path) || a.path.split('/').length - b.path.split('/').length || a.path.localeCompare(b.path))) {
    if (contextFiles.length >= MAX_CONTEXT_FILES || contextBytes + c.data.length > MAX_CONTEXT_TOTAL_BYTES) break;
    contextFiles.push({ path: c.path, content: c.data.toString('utf8') });
    contextBytes += c.data.length;
  }

  return {
    contextFiles,
    base,
    repo: {
      owner,
      name,
      ref: askedRef ?? 'default branch',
      url: `https://github.com/${owner}/${name}${askedRef ? `/tree/${askedRef}` : ''}`,
      lockfilePath: lockEntry.path,
      sourceFiles: sources.length,
      ...(await statsPromise),
    },
    lockfile,
    sources,
    skipped: candidates.length - sources.length + droppedCode,
    sourceFilesFound: candidates.length,
    ...(truncated ? { truncated: true } : {}),
  };
}
