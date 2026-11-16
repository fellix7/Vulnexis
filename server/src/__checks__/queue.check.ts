// Run: npx tsx server/src/__checks__/queue.check.ts
import assert from 'node:assert/strict';
import { heartbeat } from '../agent.js';
import { ClientLimitError, QueueFullError, ScanQueue } from '../queue.js';
import { createLimiter } from '../ratelimit.js';

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

// order + positions
{
  const q = new ScanQueue({ maxRunning: 1, maxQueued: 2, perClient: 2 });
  const a = q.join('a');
  assert.equal(a.position, 0);
  const relA = await a.slot;
  const seen: string[] = [];
  const b = q.join('b', undefined, (p) => seen.push(`b${p}`));
  const c = q.join('c', undefined, (p) => seen.push(`c${p}`));
  assert.deepEqual([b.position, c.position], [1, 2]);
  assert.throws(() => q.join('d'), QueueFullError);
  const order: string[] = [];
  b.slot.then((r) => (order.push('b'), setTimeout(r, 1)));
  c.slot.then((r) => (order.push('c'), r()));
  relA();
  await tick(20);
  assert.deepEqual(order, ['b', 'c']);
  assert.deepEqual(seen, ['c1']);
  assert.deepEqual(q.stats, { running: 0, queued: 0 });
}
// per-client cap, removal on abort, release on error
{
  const q = new ScanQueue({ maxRunning: 1, maxQueued: 5, perClient: 2 });
  const rel = await q.join('x').slot;
  const ac = new AbortController();
  const w = q.join('x', ac.signal);
  assert.throws(() => q.join('x'), ClientLimitError);
  let ypos = 0;
  const other = q.join('y', undefined, (p) => (ypos = p));
  ac.abort();
  await assert.rejects(w.slot);
  assert.equal(ypos, 1);
  q.join('x').slot.catch(() => {}); // cap freed by the abort
  assert.equal(q.stats.queued, 2);
  rel();
  const r2 = await other.slot;
  // slot release when the work throws
  await (async () => {
    try {
      throw new Error('boom');
    } catch {
      /* failed scan */
    } finally {
      r2();
      r2(); // idempotent
    }
  })();
  await tick();
  assert.equal(q.stats.running, 1); // the next waiter (x) took it, not double-released
}
// already-aborted signal
{
  const q = new ScanQueue({ maxRunning: 0 + 1, maxQueued: 1, perClient: 1 });
  const rel = await q.join('z').slot;
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(q.join('w', ac.signal).slot);
  assert.equal(q.stats.queued, 0);
  rel();
}
// rate limiter
{
  let t = 0;
  const l = createLimiter({ limits: [{ windowMs: 60_000, max: 2 }, { windowMs: 3_600_000, max: 3 }], maxKeys: 2, now: () => t });
  assert.equal(l.hit('a'), 0);
  assert.equal(l.hit('a'), 0);
  assert.equal(l.hit('a'), 60);
  t = 61_000;
  assert.equal(l.hit('a'), 0);
  t = 130_000;
  assert.ok(l.hit('a') > 3000); // hourly cap
  l.hit('b');
  l.hit('c');
  assert.ok(l.size() <= 2);
}
// heartbeat
{
  const out: string[] = [];
  const hb = heartbeat((s) => out.push(s), { type: 'ping' }, 50);
  await tick(1300);
  hb.stop();
  assert.ok(out.length >= 1 && out[0] === '{"type":"ping"}\n');
}
console.log('queue checks passed');
