import { gunzipSync } from 'node:zlib';
import { adviceFor, reasonOf } from '../net.js';
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

/** GET with a first-byte deadline and an overall deadline; one retry on network failure. */
async function getWithDeadlines(url: string, hosts: string[], read: (res: Response) => Promise<Buffer>): Promise<{ res: Response; body: Buffer }> {
  let last: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    const ctrl = new AbortController();
    const timeout = () => ctrl.abort(new DOMException('timed out', 'TimeoutError'));
    const first = setTimeout(timeout, FIRST_BYTE_MS);
    const total = setTimeout(timeout, DOWNLOAD_MS);
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'vulnexis-scanner' }, signal: ctrl.signal, redirect: 'follow' });
      clearTimeout(first);
      if (res.url && !hosts.includes(new URL(res.url).hostname)) {
        throw new RepoError('GitHub redirected the download to an unexpected address, so it was not used.');
      }
      return { res, body: res.ok ? await read(res) : Buffer.alloc(0) };
    } catch (e) {
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
const readCapped = capped(MAX_TARBALL_BYTES, 'This repository is larger than 60 MB. Upload its package-lock.json instead.');
const readCappedLockfile = capped(MAX_LOCKFILE_BYTES, 'The package-lock.json in this repository is larger than 10 MB. Upload a smaller lockfile instead.');

// One download per scan: the repository snapshot from codeload (no API quota, no token, public repos only).
async function download(owner: string, name: string, ref: string): Promise<Buffer> {
  const url = `https://codeload.github.com/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/tar.gz/${encRef(ref)}`;
  const { res, body } = await getWithDeadlines(url, ['codeload.github.com', 'github.com'], readCapped);
  if (res.status === 404) throw new RepoError('Repository not found. Check the link, and make sure the repository is public.');
  if (res.status === 403 || res.status === 429) throw new NetworkError(`HTTP ${res.status} from codeload.github.com`);
  if (!res.ok) throw new RepoError(`GitHub answered HTTP ${res.status}.`);
  try {
    // A small .tar.gz can expand to gigabytes; cap it so one link cannot exhaust server memory.
    return gunzipSync(body, { maxOutputLength: MAX_UNPACKED_BYTES });
  } catch {
    throw new RepoError('This repository is too large to read (over 300 MB unpacked). Upload its package-lock.json instead.');
  }
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
    return JSON.parse(body.toString('utf8'));
  } catch {
    throw new RepoError('package-lock.json in this repository is not valid JSON.');
  }
}

interface TarFile {
  path: string; // without the top-level "<repo>-<sha>/" folder
  data: Buffer;
}

// Minimal ustar reader: regular files only, with GNU long names and PAX path headers.
export function untar(buf: Buffer, keep: (path: string, size: number) => boolean): { files: TarFile[]; all: { path: string; size: number }[]; truncated: boolean } {
  const files: TarFile[] = [];
  const all: { path: string; size: number }[] = [];
  let off = 0;
  let longName: string | null = null;
  const str = (a: number, n: number) => buf.toString('utf8', a, a + n).replace(/\0.*$/s, '');
  let entries = 0;
  let truncated = false;
  while (off + 512 <= buf.length) {
    if (buf[off] === 0) break;
    if (++entries > MAX_TAR_ENTRIES) {
      truncated = true;
      break;
    }
    const size = parseInt(str(off + 124, 12).trim() || '0', 8);
    if (!Number.isFinite(size) || size < 0) break; // corrupt header: never loop on it
    const type = String.fromCharCode(buf[off + 156] || 48);
    const prefix = str(off + 345, 155);
    let name = longName ?? (prefix ? `${prefix}/${str(off, 100)}` : str(off, 100));
    longName = null;
    const dataStart = off + 512;
    if (type === 'L') longName = buf.toString('utf8', dataStart, dataStart + size).replace(/\0.*$/s, '');
    else if (type === 'x') {
      const m = buf.toString('utf8', dataStart, dataStart + size).match(/\d+ path=([^\n]*)\n/);
      if (m) longName = m[1]!;
    } else if (type === '0' || type === '7') {
      name = name.replace(/^[^/]*\//, '');
      all.push({ path: name, size });
      if (keep(name, size)) files.push({ path: name, data: buf.subarray(dataStart, dataStart + size) });
    }
    off = dataStart + Math.ceil(size / 512) * 512;
  }
  return { files, all, truncated };
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
export async function fetchRepoStats(owner: string, name: string): Promise<{ stars?: number; contributors?: number }> {
  const headers: Record<string, string> = { 'User-Agent': 'vulnexis-scanner', Accept: 'application/vnd.github+json' };
  if (process.env.GITHUB_TOKEN?.trim()) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN.trim()}`;
  const base = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
  const get = async (url: string) => {
    const r = await fetch(url, { headers, signal: AbortSignal.timeout(8000) });
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
  const out: { stars?: number; contributors?: number } = {};
  if (repo.status === 'fulfilled' && typeof repo.value === 'number') out.stars = repo.value;
  if (people.status === 'fulfilled' && typeof people.value === 'number' && Number.isFinite(people.value)) out.contributors = people.value;
  return out;
}

export async function fetchRepo(rawUrl: string): Promise<FetchedRepo> {
  const { owner, name, ref: askedRef } = parseRepoUrl(rawUrl);
  const ref = askedRef ?? 'HEAD';
  const statsPromise = fetchRepoStats(owner, name).catch(() => ({}));
  let tar: Buffer;
  try {
    tar = await download(owner, name, ref);
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

  const isLock = (p: string) => /(^|\/)(package-lock|npm-shrinkwrap)\.json$/.test(p) && !SKIP_DIR.test(p);
  const isSource = (p: string, size: number) => SOURCE_EXT.test(p) && !SKIP_DIR.test(p) && !SKIP_FILE.test(p) && size <= MAX_FILE_BYTES;
  const isContext = (p: string, size: number) => isContextPath(p) && size <= MAX_CONTEXT_FILE_BYTES;
  const { files, all, truncated } = untar(tar, (p, size) => (isLock(p) && size <= MAX_LOCKFILE_BYTES) || isSource(p, size) || isContext(p, size));

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
