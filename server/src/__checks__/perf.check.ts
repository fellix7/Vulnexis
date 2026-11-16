// Run: npx tsx server/src/__checks__/perf.check.ts   (offline)
// Worker pool: same answers as the synchronous functions, event loop stays free, timeout / cancel / shutdown behave.
// For the built worker: node server/dist/__checks__/perf.check.js  (after npm run build -w server)
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { buildContext, isContextPath } from '../pipeline/context.js';
import { parseLockfile } from '../pipeline/parse.js';
import { runWithStats } from '../scanStats.js';
import type { SourceFile } from '../types.js';
import { buildContextAsync, parseLockfileAsync, shutdownWorkers, TOO_LARGE_MESSAGE } from '../workers/pool.js';

const ROOT = path.resolve(import.meta.dirname, '../../..');

function load(dir: string) {
  const sources: SourceFile[] = [];
  const contextFiles: SourceFile[] = [];
  const walk = (d: string) => {
    for (const n of readdirSync(d)) {
      const f = path.join(d, n);
      const rel = path.relative(dir, f).split(path.sep).join('/');
      if (n === 'node_modules') continue;
      if (statSync(f).isDirectory()) walk(f);
      else if (/\.(js|ts)$/.test(n)) sources.push({ path: rel, content: readFileSync(f, 'utf8') });
      else if (isContextPath(rel)) contextFiles.push({ path: rel, content: readFileSync(f, 'utf8') });
    }
  };
  walk(dir);
  return { lockfile: JSON.parse(readFileSync(path.join(dir, 'package-lock.json'), 'utf8')), sources, contextFiles };
}

// ---------- identical results ----------
for (const dir of ['demo/projects/kirana-billing', 'samples/demo-app']) {
  const input = load(path.join(ROOT, dir));
  const pkgs = parseLockfile(input.lockfile);
  assert.deepEqual(await parseLockfileAsync(input.lockfile), pkgs, `${dir}: parseLockfile`);
  const sync = buildContext(input)!;
  for (const given of [undefined, pkgs]) {
    const async = (await buildContextAsync(input, given))!;
    assert.deepEqual(async.context, sync.context, `${dir}: context`);
    let n = 0;
    for (const p of pkgs) {
      assert.deepEqual(async.exposureOf(p), sync.exposureOf(p), `${dir}: exposureOf(${p.name})`);
      if (!p.dev && sync.exposureOf(p)) n++;
    }
    assert.ok(n > 0 || pkgs.every((p) => p.dev), `${dir}: some verdicts compared`);
  }
  assert.equal(await buildContextAsync({ lockfile: input.lockfile, sources: [], contextFiles: [] }), null);
  console.log(`ok  ${dir}: async == sync (${pkgs.length} packages)`);
}
await assert.rejects(parseLockfileAsync({ lockfileVersion: 1 }), /lockfileVersion 1/, 'user-facing parse errors pass through');
console.log('ok  parse errors keep their message');

// ---------- a heavy synthetic project ----------
function heavy(n: number) {
  const packages: Record<string, unknown> = { '': { dependencies: {} as Record<string, string> } };
  for (let i = 0; i < n; i++) {
    const deps: Record<string, string> = {};
    for (let k = 1; k <= 12; k++) if (i + k < n) deps[`pkg-${i + k}`] = '^1.0.0';
    packages[`node_modules/pkg-${i}`] = { version: '1.0.0', dependencies: deps };
    if (i < 1500) (packages[''] as { dependencies: Record<string, string> }).dependencies[`pkg-${i}`] = '^1.0.0';
  }
  const sources: SourceFile[] = [{ path: 'server.js', content: Array.from({ length: 119 }, (_, i) => `require('./m${i}.js');`).join('\n') + "\nrequire('express')().listen(3000);" }];
  for (let i = 0; i < 119; i++) sources.push({ path: `m${i}.js`, content: Array.from({ length: 40 }, (_, k) => `require('pkg-${(i * 40 + k) % n}');`).join('\n') });
  return { lockfile: { lockfileVersion: 3, packages }, sources, contextFiles: [] as SourceFile[] };
}
const big = heavy(6000);

const t0 = performance.now();
const pk = parseLockfile(big.lockfile);
const bs = buildContext(big)!;
for (const p of pk) bs.exposureOf(p);
const syncMs = performance.now() - t0;
console.log(`    synchronous 6,000-package analysis: ${Math.round(syncMs)} ms on the main thread`);
assert.ok(syncMs > 150, 'the heavy project must be heavy enough to block the loop if run inline');

// event loop keeps ticking while the pool analyses it
{
  let last = performance.now();
  let maxGap = 0;
  let ticks = 0;
  const timer = setInterval(() => {
    const now = performance.now();
    maxGap = Math.max(maxGap, now - last);
    last = now;
    ticks++;
  }, 10);
  const t = performance.now();
  const [parsed, built] = await Promise.all([parseLockfileAsync(big.lockfile), buildContextAsync(big)]);
  const ms = performance.now() - t;
  clearInterval(timer);
  assert.equal(parsed.length, pk.length);
  assert.deepEqual(built!.context, bs.context);
  assert.deepEqual(built!.exposureOf(pk[7]!), bs.exposureOf(pk[7]!));
  assert.ok(maxGap < 100, `event loop blocked for ${maxGap.toFixed(0)} ms`);
  console.log(`ok  event loop free during ${Math.round(ms)} ms of analysis: ${ticks} ticks, longest gap ${maxGap.toFixed(0)} ms (< 100)`);
}

// timeout: friendly error, worker replaced, pool still works
{
  process.env.ANALYSIS_TIMEOUT_MS = '30';
  await assert.rejects(buildContextAsync(big), (e) => (e as Error).message === TOO_LARGE_MESSAGE);
  delete process.env.ANALYSIS_TIMEOUT_MS;
  assert.equal((await parseLockfileAsync(load(path.join(ROOT, 'samples/demo-app')).lockfile)).length > 0, true);
  console.log('ok  timeout gives "This project is too large to analyse right now." and the pool recovers');
}

// scan cancel: job stops, worker replaced
{
  const ac = new AbortController();
  const t = performance.now();
  const p = runWithStats(() => buildContextAsync(big), ac.signal);
  setTimeout(() => ac.abort(new Error('client left')), 30);
  await assert.rejects(p, /client left/);
  assert.ok(performance.now() - t < 500);
  await assert.rejects(runWithStats(() => parseLockfileAsync(big.lockfile), AbortSignal.abort(new Error('already gone'))), /already gone/);
  assert.ok((await parseLockfileAsync(big.lockfile)).length > 0);
  console.log('ok  scan cancel terminates the job; the next job runs on a fresh worker');
}

await shutdownWorkers();
console.log('perf.check: ok (process exits without hanging)');
