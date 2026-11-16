import type { ScanRequest, SourceFile } from './types.js';

// Shape and size limits for POST /api/scan bodies. Messages are short and safe to show to users.

export class ValidationError extends Error {
  constructor(
    message: string,
    readonly status: number = 400,
  ) {
    super(message);
    this.name = 'ValidationError';
  }
}

const MAX_REPO_URL = 300;
const MAX_LOCK_PACKAGES = 20_000;
const MAX_LOCK_KEY = 1_000;
const MAX_SOURCES = 300;
const MAX_SOURCE_BYTES = 200_000;
const MAX_SOURCES_TOTAL = 3 * 1024 * 1024;
const MAX_CONTEXT = 60;
const MAX_CONTEXT_BYTES = 256 * 1024;
const MAX_CONTEXT_TOTAL = 1536 * 1024;
const MAX_PATH = 500;
const MAX_PROJECT_NAME = 200;
const SOURCE_EXT = /\.(js|jsx|ts|tsx|mjs|cjs|mts|cts)$/;

const isPlain = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const tooBig = (m: string) => new ValidationError(m, 413);
const bad = (m: string) => new ValidationError(m, 400);

function files(raw: unknown, label: string, max: number, maxEach: number, maxTotal: number, extOnly: boolean): SourceFile[] {
  if (!Array.isArray(raw)) throw bad(`"${label}" must be a list of files.`);
  if (raw.length > max) throw tooBig(`Too many ${label}: at most ${max} are accepted.`);
  const out: SourceFile[] = [];
  let total = 0;
  for (const f of raw) {
    if (!isPlain(f) || typeof f.path !== 'string' || typeof f.content !== 'string') {
      throw bad(`Each entry in "${label}" needs a text "path" and "content".`);
    }
    if (f.path.length === 0) throw bad(`A file in "${label}" has an empty path.`);
    if (f.path.length > MAX_PATH) throw tooBig(`A file path in "${label}" is longer than ${MAX_PATH} characters.`);
    if (f.path.includes('\0')) throw bad(`A file path in "${label}" contains an invalid character.`);
    if (extOnly && !SOURCE_EXT.test(f.path)) throw bad(`Only JavaScript or TypeScript files are accepted in "${label}".`);
    if (f.content.length > maxEach) throw tooBig(`A file in "${label}" is larger than ${Math.round(maxEach / 1000)} KB.`);
    total += f.content.length;
    if (total > maxTotal) throw tooBig(`The files in "${label}" are larger than ${(maxTotal / (1024 * 1024)).toFixed(1).replace(/\.0$/, '')} MB in total.`);
    out.push({ path: f.path, content: f.content });
  }
  return out;
}

export function validateScanRequest(body: unknown): ScanRequest {
  if (!isPlain(body)) throw bad('The request must be a JSON object.');

  const modes = [body.sample === true, body.repoUrl !== undefined, body.lockfile !== undefined].filter(Boolean).length;
  if (body.sample !== undefined && typeof body.sample !== 'boolean') throw bad('"sample" must be true or false.');
  if (modes !== 1) throw bad('Send exactly one of: a lockfile, a repoUrl, or sample: true.');

  const out: ScanRequest = {};
  if (body.sample === true) {
    out.sample = true;
  } else if (body.repoUrl !== undefined) {
    if (typeof body.repoUrl !== 'string' || body.repoUrl.length === 0) throw bad('"repoUrl" must be a non-empty text value.');
    if (body.repoUrl.length > MAX_REPO_URL) throw tooBig(`"repoUrl" is longer than ${MAX_REPO_URL} characters.`);
    out.repoUrl = body.repoUrl;
  } else {
    const lock = body.lockfile;
    if (!isPlain(lock)) throw bad('"lockfile" must be the parsed contents of a package-lock.json object.');
    // A missing "packages" map (lockfileVersion 1) is left for the parser, which explains how to regenerate the file.
    if (lock.packages !== undefined && lock.packages !== null) {
      if (!isPlain(lock.packages)) throw bad('The lockfile\'s "packages" must be an object.');
      const keys = Object.keys(lock.packages);
      if (keys.length > MAX_LOCK_PACKAGES) throw tooBig(`The lockfile lists more than ${MAX_LOCK_PACKAGES.toLocaleString('en-US')} packages.`);
      for (const k of keys) if (k.length > MAX_LOCK_KEY) throw tooBig(`A package path in the lockfile is longer than ${MAX_LOCK_KEY} characters.`);
    }
    out.lockfile = lock;
  }

  if (body.meta !== undefined) {
    if (!isPlain(body.meta)) throw bad('"meta" must be an object.');
    const name = body.meta.projectName;
    if (name !== undefined) {
      if (typeof name !== 'string') throw bad('"meta.projectName" must be text.');
      if (name.length > MAX_PROJECT_NAME) throw tooBig(`"meta.projectName" is longer than ${MAX_PROJECT_NAME} characters.`);
      if (name.trim()) out.meta = { projectName: name.trim() };
    }
  }

  if (body.sources !== undefined) out.sources = files(body.sources, 'sources', MAX_SOURCES, MAX_SOURCE_BYTES, MAX_SOURCES_TOTAL, true);
  if (body.contextFiles !== undefined) out.contextFiles = files(body.contextFiles, 'contextFiles', MAX_CONTEXT, MAX_CONTEXT_BYTES, MAX_CONTEXT_TOTAL, false);
  if (body.sourcesTruncated !== undefined) {
    if (typeof body.sourcesTruncated !== 'boolean') throw bad('"sourcesTruncated" must be true or false.');
    out.sourcesTruncated = body.sourcesTruncated;
  }
  return out;
}
