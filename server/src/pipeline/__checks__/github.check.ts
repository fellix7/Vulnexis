// Run: npx tsx server/src/pipeline/__checks__/github.check.ts
// Offline check of the GitHub link parser and the tarball reader (no network).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { fetchRepo, fetchRepoStats, parseRepoUrl, RepoError, untar } from '../github.js';

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

// --- S2: long input is rejected fast ---
{
  for (const evil of ['/'.repeat(100_000), '////' + 'x'.repeat(100_000), `{"x":"${'/'.repeat(50_000)}"}`]) {
    const t0 = performance.now();
    assert.throws(() => parseRepoUrl(evil), (e) => e instanceof RepoError && /too long/.test(e.message));
    const ms = performance.now() - t0;
    assert.ok(ms < 50, `long repoUrl took ${ms} ms`);
    console.log(`ok  100 KB repoUrl rejected in ${ms.toFixed(2)} ms`);
  }
  const t1 = performance.now();
  assert.deepEqual(parseRepoUrl('a/b' + '/'.repeat(290)), { owner: 'a', name: 'b' });
  assert.ok(performance.now() - t1 < 50);
}

// --- S10: owner / repo / ref validation ---
for (const bad of [
  '../user', 'a/..', '../..', './x', 'a/.', 'https://github.com/../user', 'https://github.com/a%2Fb/c',
  '_owner/repo', '-owner/repo', `${'a'.repeat(40)}/repo`, `a/${'r'.repeat(101)}`, 'https://github.com/a/b/tree/a%2e%2e/b', 'https://github.com/a/b/tree/a b', 'https://github.com/a/b/tree/' + 'r'.repeat(201)
]) {
  assert.throws(() => parseRepoUrl(bad), RepoError, `should reject ${bad}`);
}
assert.deepEqual(parseRepoUrl('https://github.com/a-b/c.d_e/tree/release/1.2.x'), { owner: 'a-b', name: 'c.d_e', ref: 'release/1.2.x' });
console.log('ok  owner/repo/ref validation');

// --- redirects, encoded URLs, lockfile cap, tar caps, skipped count (fetch mocked) ---
const gz = readFileSync(tgz);
const seen: string[] = [];
const withUrl = (r: Response, url: string) => Object.defineProperty(r, 'url', { value: url });
globalThis.fetch = (async (url: string | URL) => {
  seen.push(String(url));
  if (String(url).includes('codeload')) return withUrl(new Response(gz), 'https://evil.example/steal');
  return new Response('', { status: 404 });
}) as typeof fetch;
await assert.rejects(fetchRepo('a/b'), (e) => e instanceof RepoError && /unexpected address/.test((e as Error).message));
assert.ok(seen.includes('https://codeload.github.com/a/b/tar.gz/HEAD'));
seen.length = 0;
await assert.rejects(fetchRepo('https://github.com/a/b/tree/feat/x'), RepoError);
assert.ok(seen.includes('https://codeload.github.com/a/b/tar.gz/feat/x'));

// stats: a redirect away from api.github.com is dropped, never followed with the token
globalThis.fetch = (async () => withUrl(reply({ stargazers_count: 9 }), 'https://evil.example/')) as typeof fetch;
assert.deepEqual(await fetchRepoStats('a', 'b'), {});

// fallback lockfile download is size capped
globalThis.fetch = (async (url: string | URL) => {
  if (String(url).includes('codeload')) throw new TypeError('fetch failed');
  return new Response(new Uint8Array(11 * 1024 * 1024));
}) as typeof fetch;
await assert.rejects(fetchRepo('a/b'), (e) => e instanceof RepoError && /larger than 10 MB/.test((e as Error).message));

// tar entry cap
{
  const block = Buffer.alloc(512);
  block.write('top/f.txt', 0);
  block.write('0000000\0', 124);
  block.write('0', 156);
  const many = Buffer.concat(Array.from({ length: 50_001 }, () => block));
  const r = untar(many, () => false);
  assert.equal(r.truncated, true);
  assert.equal(r.all.length, 50_000);
  assert.equal(untar(Buffer.concat(Array.from({ length: 10 }, () => block)), () => false).truncated, false);
  const bad = Buffer.from(block);
  bad.write('-777777\0', 124);
  assert.doesNotThrow(() => untar(bad, () => false), 'negative size must not loop');
}

// skipped counts source-looking files left out for size or type
{
  const d2 = mkdtempSync(path.join(tmpdir(), 'kv-skip-'));
  mkdirSync(path.join(d2, 'r-1', 'src'), { recursive: true });
  writeFileSync(path.join(d2, 'r-1', 'package-lock.json'), '{"lockfileVersion":3,"packages":{"":{}}}');
  writeFileSync(path.join(d2, 'r-1', 'src', 'ok.js'), 'x');
  writeFileSync(path.join(d2, 'r-1', 'src', 'big.ts'), 'x'.repeat(300_000));
  writeFileSync(path.join(d2, 'r-1', 'src', 'App.vue'), '<template/>');
  writeFileSync(path.join(d2, 'r-1', 'src', 'big.min.js'), 'x'.repeat(300_000));
  const t2 = path.join(d2, 'r.tgz');
  execFileSync('tar', ['-czf', t2, '-C', d2, 'r-1']);
  const body = readFileSync(t2);
  globalThis.fetch = (async (url: string | URL) =>
    String(url).includes('codeload') ? new Response(body) : new Response('', { status: 404 })) as typeof fetch;
  const r = await fetchRepo('a/b');
  assert.equal(r.sources.length, 1);
  assert.equal(r.skipped, 2, 'oversized .ts and .vue count; .min.js does not');
  console.log('ok  skipped counts dropped code');
}
globalThis.fetch = realFetch;

console.log('github.check: ok');
