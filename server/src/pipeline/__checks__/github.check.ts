// Run: npx tsx server/src/pipeline/__checks__/github.check.ts
// Offline check of the GitHub link parser and the tarball reader (no network).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { gunzipSync, createGzip } from 'node:zlib';
import { TarParser } from '../github.js';
import { withScanSignal } from '../../scanStats.js';
import { runWithStats } from '../../scanStats.js';
import { clearRepoStatsCache, fetchRepo, fetchRepoStats, parseRepoUrl, RepoError, untar } from '../github.js';

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
clearRepoStatsCache();
assert.deepEqual(await fetchRepoStats('OWASP', 'NodeGoat'), { stars: 2140, contributors: 87 });
clearRepoStatsCache();
globalThis.fetch = (async (url: string | URL) => (String(url).includes('/contributors') ? reply([{}, {}, {}]) : reply({ stargazers_count: 3 }))) as typeof fetch;
assert.deepEqual(await fetchRepoStats('a', 'b'), { stars: 3, contributors: 3 }, 'one page: count the list');
clearRepoStatsCache();
globalThis.fetch = (async () => new Response('rate limited', { status: 403 })) as typeof fetch;
assert.deepEqual(await fetchRepoStats('a', 'b'), {}, 'rate limit: left out, never an error');
clearRepoStatsCache();
globalThis.fetch = (async () => { throw new TypeError('fetch failed'); }) as typeof fetch;
assert.deepEqual(await fetchRepoStats('a', 'b'), {}, 'network failure: left out');
// F16: repeated scans of one repository make no further API calls for an hour
{
  clearRepoStatsCache();
  let calls = 0;
  globalThis.fetch = (async (url: string | URL) => {
    calls++;
    return String(url).includes('/contributors') ? reply([{}]) : reply({ stargazers_count: 5 });
  }) as typeof fetch;
  const [x, y] = await Promise.all([fetchRepoStats('Own', 'Rep'), fetchRepoStats('own', 'rep')]);
  await fetchRepoStats('own', 'rep');
  assert.deepEqual([x, y], [{ stars: 5, contributors: 1 }, { stars: 5, contributors: 1 }]);
  assert.equal(calls, 2, 'two API requests in total, not per scan');
  console.log('ok  repo stats cached');
}
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
clearRepoStatsCache();
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
    String(url).includes('codeload') ? new Response(body as unknown as BodyInit) : new Response('', { status: 404 })) as typeof fetch;
  const r = await fetchRepo('a/b');
  assert.equal(r.sources.length, 1);
  assert.equal(r.skipped, 2, 'oversized .ts and .vue count; .min.js does not');
  console.log('ok  skipped counts dropped code');
}
globalThis.fetch = realFetch;

// --- F7: streaming tar reader ---
function header(name: string, size: number, type = '0'): Buffer {
  const h = Buffer.alloc(512);
  h.write(name, 0, 100);
  h.write(size.toString(8).padStart(11, '0') + '\0', 124);
  h.write(type, 156);
  return h;
}
const pad = (n: number) => Buffer.alloc((512 - (n % 512)) % 512);
/** A tar made of `[name, size-or-content]` entries; numeric sizes are generated lazily as zeros. */
function* tarChunks(entries: [string, number | string, string?][]): Generator<Buffer> {
  const zeros = Buffer.alloc(1024 * 1024);
  for (const [name, body, type] of entries) {
    const size = typeof body === 'number' ? body : Buffer.byteLength(body);
    yield header(name, size, type);
    if (typeof body === 'string') yield Buffer.from(body);
    else for (let left = size; left > 0; left -= zeros.length) yield zeros.subarray(0, Math.min(left, zeros.length));
    yield pad(size);
  }
  yield Buffer.alloc(1024);
}
const gzipOf = async (chunks: Iterable<Buffer>) => {
  const out: Buffer[] = [];
  for await (const c of Readable.from(chunks, { objectMode: false }).pipe(createGzip({ level: 1 })) as AsyncIterable<Buffer>) out.push(c);
  return Buffer.concat(out);
};
const serve = (body: Buffer) => {
  globalThis.fetch = (async (url: string | URL) => (String(url).includes('codeload') ? new Response(body as unknown as BodyInit) : new Response('', { status: 404 }))) as typeof fetch;
};
const LOCK = '{"lockfileVersion":3,"packages":{"":{}}}';

// the parser gives the same answer fed one byte at a time, with GNU long names and PAX paths
{
  const longName = 'top/' + 'd/'.repeat(80) + 'long.js';
  const pax = `${String(' path=p/pax/file.js\n'.length + 2)} path=p/pax/file.js\n`;
  const tar = Buffer.concat([...tarChunks([['top/@LongLink', longName, 'L'], ['top/short', 'x'], ['top/pax', pax, 'x'], ['top/ignored', 'y'], ['top/a.txt', 'hello']])]);
  const whole = untar(tar, (p) => p.endsWith('.js') || p.endsWith('.txt'));
  const p = new TarParser((q) => q.endsWith('.js') || q.endsWith('.txt'));
  for (let i = 0; i < tar.length; i += 7) p.push(tar.subarray(i, i + 7));
  const bytewise = p.finish();
  assert.deepEqual(bytewise.all, whole.all);
  assert.deepEqual(bytewise.files.map((f) => [f.path, f.data.toString()]), whole.files.map((f) => [f.path, f.data.toString()]));
  assert.ok(whole.all.some((f) => f.path === longName.replace(/^top\//, '')), 'GNU long name');
  assert.ok(whole.all.some((f) => f.path === 'pax/file.js'), 'PAX path');
  console.log('ok  incremental tar parser: chunking-independent, long names, PAX');
}

// 200 MB unpacked, mostly large files nobody reads: memory stays flat and the answer is right
{
  const entries: [string, number | string][] = [['r-1/package-lock.json', LOCK], ['r-1/src/app.js', 'require("x")']];
  for (let i = 0; i < 20; i++) entries.push([`r-1/data/blob-${i}.bin`, 10 * 1024 * 1024]);
  const gzBody = await gzipOf(tarChunks(entries));
  serve(gzBody);
  global.gc?.();
  const base = process.memoryUsage();
  let peak = 0;
  const t = setInterval(() => {
    const m = process.memoryUsage();
    peak = Math.max(peak, m.heapUsed + m.external - base.heapUsed - base.external);
  }, 5);
  const t0 = performance.now();
  const r = await fetchRepo('a/b');
  clearInterval(t);
  const mb = peak / 1048576;
  assert.equal(r.repo.lockfilePath, 'package-lock.json');
  assert.equal(r.sources.length, 1);
  assert.ok(mb < 50, `heap+external grew ${mb.toFixed(1)} MB`);
  console.log(`ok  200 MB unpacked tarball (${(gzBody.length / 1048576).toFixed(2)} MB gz) streamed in ${Math.round(performance.now() - t0)} ms, peak memory growth ${mb.toFixed(1)} MB`);
}

// caps: unpacked size, compressed size; both reject with a friendly RepoError
{
  serve(await gzipOf(tarChunks([['r-1/package-lock.json', LOCK], ['r-1/big.bin', 310 * 1024 * 1024]])));
  await assert.rejects(fetchRepo('a/b'), (e) => e instanceof RepoError && /over 300 MB/.test((e as Error).message));
  const noise = randomBytes(61 * 1024 * 1024);
  serve(await gzipOf([header('r-1/package-lock.json', LOCK.length), Buffer.from(LOCK), pad(LOCK.length), header('r-1/n.bin', noise.length), noise, pad(noise.length), Buffer.alloc(1024)]));
  await assert.rejects(fetchRepo('a/b'), (e) => e instanceof RepoError && /larger than 60 MB/.test((e as Error).message));
  serve(Buffer.from('this is not gzip at all'));
  await assert.rejects(fetchRepo('a/b'), (e) => e instanceof RepoError && /could not be unpacked/.test((e as Error).message));
  // 50,000-entry cap stops the stream and flags truncated
  const many: [string, number | string][] = [['r-1/package-lock.json', LOCK]];
  for (let i = 0; i < 50_010; i++) many.push([`r-1/f${i}.txt`, 0]);
  serve(await gzipOf(tarChunks(many)));
  assert.equal((await fetchRepo('a/b')).truncated, true);
  console.log('ok  unpacked / compressed / entry caps');
}

// a cancelled scan aborts the download and is not retried
{
  let calls = 0;
  const ac = new AbortController();
  globalThis.fetch = (async (_u: string | URL, init?: RequestInit) => {
    calls++;
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(new Uint8Array([0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 0, 3]));
        init!.signal!.addEventListener('abort', () => c.error(init!.signal!.reason));
      },
    });
    setTimeout(() => ac.abort(new Error('cancelled')), 20);
    return new Response(stream);
  }) as typeof fetch;
  await assert.rejects(runWithStats(() => fetchRepo('a/b'), ac.signal), /cancelled/);
  assert.equal(calls, 1);
  void withScanSignal;
  console.log('ok  scan cancel aborts the repo download without a retry');
}
globalThis.fetch = realFetch;

console.log('github.check: ok');
