import { gunzipSync } from 'node:zlib';
import type { RepoRef, SourceFile } from '../types.js';

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

export function parseRepoUrl(raw: string): { owner: string; name: string; ref?: string } {
  const s = raw.trim().replace(/\/+$/, '').replace(/\.git$/, '');
  const short = s.match(/^([\w.-]+)\/([\w.-]+)$/);
  if (short) return { owner: short[1]!, name: short[2]! };
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
  return { owner, name, ref: kind === 'tree' && rest.length ? rest.join('/') : undefined };
}

const MAX_TARBALL_BYTES = 60 * 1024 * 1024;
const MAX_UNPACKED_BYTES = 300 * 1024 * 1024;

// One download per scan: the repository snapshot from codeload (no API quota, no token, public repos only).
async function download(owner: string, name: string, ref: string): Promise<Buffer> {
  const url = `https://codeload.github.com/${owner}/${name}/tar.gz/${ref.split('/').map(encodeURIComponent).join('/')}`;
  let res: Response;
  try {
    res = await fetch(url, { headers: { 'User-Agent': 'vulnexis-scanner' }, signal: AbortSignal.timeout(TIMEOUT_MS * 2) });
  } catch {
    throw new RepoError('Could not reach GitHub. Try again, or upload the lockfile instead.');
  }
  if (res.status === 404) throw new RepoError('Repository not found. Check the link, and make sure the repository is public.');
  if (res.status === 403 || res.status === 429) throw new RepoError('GitHub is limiting requests from this server. Try again in a minute.');
  if (!res.ok || !res.body) throw new RepoError(`GitHub answered HTTP ${res.status}.`);
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of res.body as unknown as AsyncIterable<Uint8Array>) {
    size += c.length;
    if (size > MAX_TARBALL_BYTES) throw new RepoError('This repository is larger than 60 MB. Upload its package-lock.json instead.');
    chunks.push(Buffer.from(c));
  }
  try {
    // A small .tar.gz can expand to gigabytes; cap it so one link cannot exhaust server memory.
    return gunzipSync(Buffer.concat(chunks), { maxOutputLength: MAX_UNPACKED_BYTES });
  } catch {
    throw new RepoError('This repository is too large to read (over 300 MB unpacked). Upload its package-lock.json instead.');
  }
}

interface TarFile {
  path: string; // without the top-level "<repo>-<sha>/" folder
  data: Buffer;
}

// Minimal ustar reader: regular files only, with GNU long names and PAX path headers.
export function untar(buf: Buffer, keep: (path: string, size: number) => boolean): { files: TarFile[]; all: { path: string; size: number }[] } {
  const files: TarFile[] = [];
  const all: { path: string; size: number }[] = [];
  let off = 0;
  let longName: string | null = null;
  const str = (a: number, n: number) => buf.toString('utf8', a, a + n).replace(/\0.*$/s, '');
  while (off + 512 <= buf.length) {
    if (buf[off] === 0) break;
    const size = parseInt(str(off + 124, 12).trim() || '0', 8);
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
  return { files, all };
}

export interface FetchedRepo {
  repo: RepoRef;
  lockfile: unknown;
  sources: SourceFile[];
  skipped: number; // source files not read because of the limits above
  sourceFilesFound: number;
}

export async function fetchRepo(rawUrl: string): Promise<FetchedRepo> {
  const { owner, name, ref: askedRef } = parseRepoUrl(rawUrl);
  const ref = askedRef ?? 'HEAD';
  const tar = await download(owner, name, ref);

  const isLock = (p: string) => /(^|\/)(package-lock|npm-shrinkwrap)\.json$/.test(p) && !SKIP_DIR.test(p);
  const isSource = (p: string, size: number) => SOURCE_EXT.test(p) && !SKIP_DIR.test(p) && !SKIP_FILE.test(p) && size <= MAX_FILE_BYTES;
  const { files, all } = untar(tar, (p, size) => (isLock(p) && size <= MAX_LOCKFILE_BYTES) || isSource(p, size));

  // Shallowest lockfile wins (monorepos keep it at the root).
  const lockEntry = files.filter((f) => isLock(f.path)).sort((a, b) => a.path.split('/').length - b.path.split('/').length)[0];
  if (!lockEntry) {
    const hasYarn = all.some((b) => /(^|\/)(yarn\.lock|pnpm-lock\.yaml)$/.test(b.path));
    throw new RepoError(
      hasYarn
        ? 'This repository uses Yarn or pnpm. Vulnexis currently reads npm lockfiles (package-lock.json) only.'
        : 'No package-lock.json found in this repository. Vulnexis needs an npm lockfile to know exact versions.',
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
  const sources: SourceFile[] = [];
  let total = 0;
  for (const c of candidates) {
    if (sources.length >= MAX_SOURCE_FILES || total + c.data.length > MAX_TOTAL_BYTES) break;
    sources.push({ path: c.path.slice(base.length), content: c.data.toString('utf8') });
    total += c.data.length;
  }

  return {
    repo: {
      owner,
      name,
      ref: askedRef ?? 'default branch',
      url: `https://github.com/${owner}/${name}${askedRef ? `/tree/${askedRef}` : ''}`,
      lockfilePath: lockEntry.path,
      sourceFiles: sources.length,
    },
    lockfile,
    sources,
    skipped: candidates.length - sources.length,
    sourceFilesFound: candidates.length,
  };
}
