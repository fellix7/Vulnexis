// Run: npx tsx server/src/pipeline/__checks__/github.check.ts
// Offline check of the GitHub link parser and the tarball reader (no network).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { fetchRepoStats, parseRepoUrl, RepoError, untar } from '../github.js';

// --- links ---
assert.deepEqual(parseRepoUrl('https://github.com/OWASP/NodeGoat'), { owner: 'OWASP', name: 'NodeGoat', ref: undefined });
assert.deepEqual(parseRepoUrl('github.com/OWASP/NodeGoat.git/'), { owner: 'OWASP', name: 'NodeGoat', ref: undefined });
assert.deepEqual(parseRepoUrl('OWASP/NodeGoat'), { owner: 'OWASP', name: 'NodeGoat' });
assert.deepEqual(parseRepoUrl('https://github.com/a/b/tree/feat/x'), { owner: 'a', name: 'b', ref: 'feat/x' });
assert.throws(() => parseRepoUrl('https://gitlab.com/a/b'), RepoError);
assert.throws(() => parseRepoUrl('https://github.com/onlyowner'), RepoError);

// --- tarball shaped like codeload's: one top folder, a long (>100 char) path, a skipped file ---
const dir = mkdtempSync(path.join(tmpdir(), 'kv-tar-'));
const top = path.join(dir, 'repo-abc123');
const deep = path.join(top, 'src', 'a'.repeat(60), 'b'.repeat(60));
mkdirSync(deep, { recursive: true });
writeFileSync(path.join(top, 'package-lock.json'), '{"lockfileVersion":3,"packages":{}}');
writeFileSync(path.join(deep, 'deep.js'), 'require("x")');
writeFileSync(path.join(top, 'README.md'), '# hi');
const tgz = path.join(dir, 'r.tgz');
execFileSync('tar', ['-czf', tgz, '-C', dir, 'repo-abc123']);

const { files, all } = untar(gunzipSync(readFileSync(tgz)), (p) => p.endsWith('.json') || p.endsWith('.js'));
const paths = files.map((f) => f.path).sort();
assert.deepEqual(paths, ['package-lock.json', `src/${'a'.repeat(60)}/${'b'.repeat(60)}/deep.js`]);
assert.equal(files.find((f) => f.path === 'package-lock.json')!.data.toString(), '{"lockfileVersion":3,"packages":{}}');
assert.ok(all.some((f) => f.path === 'README.md'), 'every file is listed even when not kept');

// --- stars and contributors (fetch mocked: no network) ---
const realFetch = globalThis.fetch;
const reply = (body: unknown, link?: string) => new Response(JSON.stringify(body), { status: 200, headers: link ? { link } : {} });
globalThis.fetch = (async (url: string | URL) => {
  const u = String(url);
  if (u.endsWith('/repos/OWASP/NodeGoat')) return reply({ stargazers_count: 2140 });
  if (u.includes('/contributors')) return reply([{}], '<https://api.github.com/x?per_page=1&page=2>; rel="next", <https://api.github.com/x?per_page=1&page=87>; rel="last"');
  return new Response('', { status: 404 });
}) as typeof fetch;
assert.deepEqual(await fetchRepoStats('OWASP', 'NodeGoat'), { stars: 2140, contributors: 87 });
globalThis.fetch = (async (url: string | URL) => (String(url).includes('/contributors') ? reply([{}, {}, {}]) : reply({ stargazers_count: 3 }))) as typeof fetch;
assert.deepEqual(await fetchRepoStats('a', 'b'), { stars: 3, contributors: 3 }, 'one page: count the list');
globalThis.fetch = (async () => new Response('rate limited', { status: 403 })) as typeof fetch;
assert.deepEqual(await fetchRepoStats('a', 'b'), {}, 'rate limit: left out, never an error');
globalThis.fetch = (async () => { throw new TypeError('fetch failed'); }) as typeof fetch;
assert.deepEqual(await fetchRepoStats('a', 'b'), {}, 'network failure: left out');
globalThis.fetch = realFetch;

console.log('github.check: ok');
