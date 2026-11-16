// Run: npx tsx server/src/__checks__/http.check.ts
// Per-host limiter, abort-aware fetchRetry (offline: fetch is mocked).
import assert from 'node:assert/strict';
import { createHostLimiter, fetchRetry, hostLimiter, HTTP_MAX_PER_HOST, sleep } from '../http.js';
import { runWithStats } from '../scanStats.js';

const tick = (ms = 1) => new Promise((r) => setTimeout(r, ms));
const realFetch = globalThis.fetch;

// limiter: 100 concurrent tasks, cap 5, never above it, FIFO
{
  const lim = createHostLimiter(5);
  let active = 0;
  let peak = 0;
  const order: number[] = [];
  await Promise.all(
    Array.from({ length: 100 }, async (_, i) => {
      const release = await lim.acquire('h');
      order.push(i);
      peak = Math.max(peak, ++active);
      await tick(1 + (i % 3));
      active--;
      release();
    }),
  );
  assert.equal(peak, 5);
  assert.deepEqual(order, [...order].sort((a, b) => a - b), 'FIFO');
  assert.equal(lim.inFlight('h'), 0);
  console.log(`ok  limiter: 100 tasks, peak in flight ${peak} (cap 5), FIFO`);
}

// aborted waiter leaves the queue and does not take a slot
{
  const lim = createHostLimiter(1);
  const r1 = await lim.acquire('h');
  const ac = new AbortController();
  const w = lim.acquire('h', ac.signal);
  const w2 = lim.acquire('h');
  assert.equal(lim.queued('h'), 2);
  ac.abort(new Error('gone'));
  await assert.rejects(w, /gone/);
  assert.equal(lim.queued('h'), 1);
  r1();
  const r2 = await w2;
  assert.equal(lim.inFlight('h'), 1);
  r2();
  r2(); // double release is harmless
  assert.equal(lim.inFlight('h'), 0);
  assert.equal(lim.queued('h'), 0);
  await assert.rejects(lim.acquire('h', AbortSignal.abort(new Error('early'))), /early/);
  console.log('ok  limiter: aborted waiter leaves the queue');
}

// fetchRetry: 100 concurrent requests to one host never exceed HTTP_MAX_PER_HOST; other hosts are independent
{
  let active = 0;
  let peak = 0;
  globalThis.fetch = (async () => {
    peak = Math.max(peak, ++active);
    await tick(3);
    active--;
    return new Response('{"ok":true}');
  }) as typeof fetch;
  await Promise.all(Array.from({ length: 100 }, () => fetchRetry('https://one.example/x', undefined, (r) => r.json())));
  assert.ok(peak <= HTTP_MAX_PER_HOST && peak > 1, `peak ${peak}`);
  assert.equal(hostLimiter.inFlight('one.example'), 0);
  console.log(`ok  fetchRetry: 100 concurrent requests, peak ${peak} (cap ${HTTP_MAX_PER_HOST})`);
}

// scan cancel: no retry, no sleep, queued requests leave the queue
{
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    return new Response('busy', { status: 503, headers: { 'retry-after': '5' } });
  }) as typeof fetch;
  const ac = new AbortController();
  const t0 = performance.now();
  const p = runWithStats(() => fetchRetry('https://two.example/x', undefined, (r) => r.text()), ac.signal);
  setTimeout(() => ac.abort(new Error('client left')), 30);
  await assert.rejects(p, /client left/);
  assert.equal(calls, 1, 'no retry after the first 503 once cancelled');
  assert.ok(performance.now() - t0 < 500, 'the 5 s Retry-After sleep was cut short');

  // abort during an in-flight fetch: the attempt is not retried
  calls = 0;
  const ac2 = new AbortController();
  globalThis.fetch = ((_u: string, init?: RequestInit) => {
    calls++;
    return new Promise((_, rej) => init!.signal!.addEventListener('abort', () => rej(init!.signal!.reason)));
  }) as typeof fetch;
  const p2 = runWithStats(() => fetchRetry('https://two.example/y', undefined, (r) => r.text()), ac2.signal);
  setTimeout(() => ac2.abort(new Error('deadline')), 10);
  await assert.rejects(p2, /deadline/);
  assert.equal(calls, 1);

  // queued behind a full host: aborting removes the waiter
  globalThis.fetch = ((_u: string, init?: RequestInit) =>
    new Promise((_, rej) => init!.signal!.addEventListener('abort', () => rej(init!.signal!.reason)))) as typeof fetch; // never answers, like a hung server
  const ac3 = new AbortController();
  const hogs = Array.from({ length: HTTP_MAX_PER_HOST }, () => {
    const c = new AbortController();
    const p = runWithStats(() => fetchRetry('https://three.example/z', undefined, (r) => r.text()), c.signal);
    p.catch(() => {});
    return c;
  });
  await tick(5);
  const waiting = runWithStats(() => fetchRetry('https://three.example/z', undefined, (r) => r.text()), ac3.signal);
  await tick(5);
  assert.equal(hostLimiter.queued('three.example'), 1);
  ac3.abort(new Error('queued, then cancelled'));
  await assert.rejects(waiting, /queued, then cancelled/);
  assert.equal(hostLimiter.queued('three.example'), 0);
  hogs.forEach((c) => c.abort(new Error('done')));
  await tick(5);
  assert.equal(hostLimiter.inFlight('three.example'), 0);

  const ac4 = new AbortController();
  const s = sleep(10_000, ac4.signal);
  ac4.abort(new Error('stop'));
  await assert.rejects(s, /stop/);
  console.log('ok  fetchRetry: cancel stops retries, sleeps and queue waits');
}

// OSV advisory details: one request per advisory id, however many (package, advisory) pairs name it
{
  const { getAdvisoryOrNull } = await import('../pipeline/osv.js');
  const { clearMemoryCache } = await import('../cache.js');
  clearMemoryCache();
  const urls: string[] = [];
  globalThis.fetch = (async (u: string | URL) => {
    urls.push(String(u));
    await tick(2);
    return new Response(JSON.stringify({ id: 'GHSA-aaaa', aliases: [], summary: 's' }));
  }) as typeof fetch;
  await runWithStats(() => Promise.all(['a', 'b', 'c', 'd'].map((pkg) => getAdvisoryOrNull('GHSA-aaaa', pkg))));
  assert.equal(urls.length, 1);
  console.log('ok  osv: advisory detail fetched once for 4 packages');
}
globalThis.fetch = realFetch;
console.log('http.check: ok');
