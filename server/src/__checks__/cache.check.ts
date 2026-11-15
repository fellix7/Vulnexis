// Run: npx tsx server/src/__checks__/cache.check.ts   (offline; uses a temp CACHE_DIR)
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { cached, cacheConfig, clearMemoryCache, memorySize, memoryUsedBytes, peek, savedOrThrow, store } from '../cache.js';
import { runWithStats, savedDataNote } from '../scanStats.js';

const dir = mkdtempSync(path.join(tmpdir(), 'vx-cache-'));
process.env.CACHE_DIR = path.join(dir, 'cache');
delete process.env.CACHE_WRITE_DISK;
delete process.env.OFFLINE;
const sleep = (ms = 5) => new Promise((r) => setTimeout(r, ms));
let clock = 1_000_000;
cacheConfig.now = () => clock;

// 1. Served from memory; fetcher runs once.
{
  let calls = 0;
  const f = async () => (calls++, 'v');
  assert.equal(await cached('epss', 'a', f), 'v');
  assert.equal(await cached('epss', 'a', f), 'v');
  assert.equal(calls, 1);
  console.log('ok  memory hit');
}

// 2. TTL per namespace.
{
  const H = 3_600_000;
  const run = async (ns: string, key: string, ageMs: number) => {
    let calls = 0;
    await cached(ns, key, async () => (calls++, 1));
    clock += ageMs;
    await cached(ns, key, async () => (calls++, 1));
    return calls;
  };
  assert.equal(await run('npm-registry', 'n1', H - 1000), 1, 'npm fresh at 59 min');
  assert.equal(await run('npm-registry', 'n2', H + 1000), 2, 'npm expired after 1 h');
  assert.equal(await run('osv-query', 'q1', 5 * H), 1, 'osv fresh at 5 h');
  assert.equal(await run('osv-query', 'q2', 6 * H + 1000), 2, 'osv expired after 6 h');
  assert.equal(await run('osv-vuln', 'v1', 6 * H + 1000), 2);
  assert.equal(await run('epss', 'e1', 23 * H), 1, 'epss fresh at 23 h');
  assert.equal(await run('epss', 'e2', 24 * H + 1000), 2, 'epss expired after 24 h');
  assert.equal(await run('gemini-package', 'g1', 24 * H + 1000), 2, 'gemini expired after 24 h');
  console.log('ok  TTL expiry');
}

// 3. LRU bound and recency.
{
  clearMemoryCache();
  cacheConfig.maxEntries = 3;
  for (const k of ['a', 'b', 'c']) await store('epss', k, k);
  assert.equal(await peek('epss', 'a'), 'a'); // touch a: b is now the oldest
  await store('epss', 'd', 'd');
  assert.equal(memorySize(), 3);
  assert.equal(await peek('epss', 'b'), undefined, 'oldest evicted');
  assert.equal(await peek('epss', 'a'), 'a');
  cacheConfig.maxEntries = 20_000;

// Byte cap: big answers evict old ones even when the entry count is low.
clearMemoryCache();
cacheConfig.maxBytes = 10_000;
for (let i = 0; i < 10; i++) await store('osv-vuln', `big-${i}`, 'x'.repeat(1000)); // ~2 KB each in UTF-16
assert.ok(memoryUsedBytes() <= 10_000, `memory ${memoryUsedBytes()} over the byte cap`);
assert.ok(memorySize() < 10, 'old entries were evicted by size');
await store('osv-vuln', 'huge', 'x'.repeat(5000)); // over a quarter of the cap: not kept
assert.equal(await peek('osv-vuln', 'huge'), undefined);
cacheConfig.maxBytes = 128 * 1024 * 1024;
console.log('ok  byte cap evicts by size and skips oversized answers');
  clearMemoryCache();
  console.log('ok  LRU bound');
}

// 4. No disk writes by default.
{
  await cached('epss', 'nodisk', async () => 1);
  await store('epss', 'nodisk2', 2);
  assert.equal(existsSync(process.env.CACHE_DIR!), false, 'cache dir must not be created');
  console.log('ok  no disk writes by default');
}

// 5. CACHE_WRITE_DISK=1 writes atomically (no temp files left); a failing disk never throws.
{
  process.env.CACHE_WRITE_DISK = '1';
  await cached('epss', 'ondisk', async () => 42);
  const files = readdirSync(path.join(process.env.CACHE_DIR!, 'epss'));
  assert.equal(files.length, 1);
  assert.ok(files[0]!.endsWith('.json'), 'renamed into place');
  // CACHE_DIR below a regular file: mkdir fails.
  const blocker = path.join(dir, 'blocker');
  writeFileSync(blocker, 'x');
  process.env.CACHE_DIR = path.join(blocker, 'sub');
  const warn = console.warn;
  let warnings = 0;
  console.warn = () => void warnings++;
  assert.equal(await cached('epss', 'badDisk', async () => 7), 7, 'scan value still returned');
  await cached('epss', 'badDisk2', async () => 8);
  console.warn = warn;
  assert.equal(warnings, 1, 'logged once');
  delete process.env.CACHE_WRITE_DISK;
  console.log('ok  failed disk write does not throw');
}

// 6. Fallback to saved .cache data: only entries younger than 7 days; per-scan counters and age.
{
  process.env.CACHE_DIR = path.join(dir, 'fb');
  process.env.CACHE_WRITE_DISK = '1';
  clearMemoryCache();
  clock = Date.now(); // stat() uses real mtimes
  await cached('epss', 'old', async () => 'OLD');
  await cached('epss', 'young', async () => 'YOUNG');
  delete process.env.CACHE_WRITE_DISK;
  const epssDir = path.join(process.env.CACHE_DIR, 'epss');
  const [f1, f2] = readdirSync(epssDir).map((f) => path.join(epssDir, f));
  const content = (f: string) => JSON.parse(readFileSync(f, 'utf8')).key;
  const old = [f1!, f2!].find((f) => content(f) === 'old')!;
  const eightDays = new Date(Date.now() - 8 * 86_400_000);
  utimesSync(old, eightDays, eightDays);
  const young = [f1!, f2!].find((f) => content(f) === 'young')!;
  const twoDays = new Date(Date.now() - 2 * 86_400_000);
  utimesSync(young, twoDays, twoDays);
  clearMemoryCache();
  const boom = async () => {
    throw new Error('network down');
  };
  const s = await runWithStats(async (st) => {
    assert.equal(await cached('epss', 'young', boom), 'YOUNG');
    await assert.rejects(cached('epss', 'old', boom), /network down/);
    assert.equal(await savedOrThrow('epss', 'young', new Error('x')), 'YOUNG');
    return st;
  });
  assert.equal(s.savedFromCache, 2);
  assert.ok(s.oldestSavedMs > 1.9 * 86_400_000 && s.oldestSavedMs < 2.1 * 86_400_000);
  assert.match(savedDataNote(s)!, /2 from saved copies up to about 2 days old/);
  assert.match(savedDataNote({ ...s, savedFromCache: 0, savedFromDemo: 3 })!, /3 from saved demo data/);
  assert.equal(savedDataNote({ ...s, savedFromCache: 0 }), null);
  console.log('ok  fallback only for saved data younger than 7 days, with its age');
}

// 7. In-flight dedup: identical concurrent lookups share one fetch; failures are shared too.
{
  clearMemoryCache();
  let calls = 0;
  const slow = async () => (calls++, await sleep(20), 'shared');
  const out = await Promise.all([cached('epss', 'dup', slow), cached('epss', 'dup', slow), cached('epss', 'dup', slow)]);
  assert.deepEqual(out, ['shared', 'shared', 'shared']);
  assert.equal(calls, 1);
  console.log('ok  in-flight dedup');
}

// 8. Offline mode: no network, committed snapshots only.
{
  process.env.OFFLINE = '1';
  await assert.rejects(cached('epss', 'definitely-not-saved', async () => 1), /Offline mode/);
  delete process.env.OFFLINE;
  console.log('ok  offline miss');
}
console.log('ALL CACHE CHECKS PASSED');

