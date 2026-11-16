// Run: npx tsx server/src/__checks__/queue.check.ts
import assert from 'node:assert/strict';
import { heartbeat } from '../agent.js';
import { ClientLimitError, QueueFullError, ScanQueue } from '../queue.js';
import { clientIp, clientKey, createLimiter, ipInCidr, normalizeIp, parseCidr } from '../ratelimit.js';

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
// per user, not per key: two keys of one user share the plan's max_concurrent
{
  const keyReq = (userId: string, keyId: string) => ({ ip: '198.51.100.1', res: { locals: { caller: { kind: 'key', userId, keyId, planId: 'free' } } } });
  const userReq = (userId: string) => ({ ip: '198.51.100.1', res: { locals: { caller: { kind: 'user', userId, planId: 'free' } } } });
  assert.equal(clientKey(keyReq('u1', 'k1')), 'user:u1');
  assert.equal(clientKey(keyReq('u1', 'k2')), 'user:u1', 'another key of the same user: same identity');
  assert.equal(clientKey(userReq('u1')), 'user:u1', 'and the browser session of that user too');
  assert.notEqual(clientKey(keyReq('u2', 'k1')), 'user:u1');
  assert.equal(clientKey({ ip: '198.51.100.1' }), '198.51.100.1');
  const q = new ScanQueue({ maxRunning: 10, maxQueued: 10, perClient: 2 });
  const cap = 2; // the free plan's max_concurrent
  q.join(clientKey(keyReq('u1', 'k1')), undefined, undefined, cap);
  q.join(clientKey(keyReq('u1', 'k2')), undefined, undefined, cap);
  assert.throws(() => q.join(clientKey(keyReq('u1', 'k3')), undefined, undefined, cap), ClientLimitError, 'a third scan through a third key is refused');
  assert.throws(() => q.join(clientKey(userReq('u1')), undefined, undefined, cap), ClientLimitError, 'also from the browser');
  q.join(clientKey(keyReq('u2', 'k1')), undefined, undefined, cap); // another user is unaffected
  console.log('ok  queue: one user, many keys, one cap');
}
// client address: IPv6 /64, IPv4-mapped, trusted proxy header
{
  const saved = { h: process.env.TRUSTED_CLIENT_IP_HEADER, c: process.env.TRUSTED_PROXY_CIDRS };
  delete process.env.TRUSTED_CLIENT_IP_HEADER;
  delete process.env.TRUSTED_PROXY_CIDRS;
  assert.equal(normalizeIp('2001:db8:1:2:aaaa:bbbb:cccc:dddd'), '2001:db8:1:2::/64');
  assert.equal(normalizeIp('2001:0DB8:0001:0002::1'), '2001:db8:1:2::/64');
  assert.equal(normalizeIp('2001:db8::1'), '2001:db8:0:0::/64');
  assert.equal(normalizeIp('::ffff:203.0.113.9'), '203.0.113.9', 'IPv4-mapped: the IPv4 address');
  assert.equal(normalizeIp('::ffff:cb00:7109'), '203.0.113.9', 'hex form of the same');
  assert.equal(normalizeIp('203.0.113.9'), '203.0.113.9');
  assert.equal(normalizeIp('fe80::1%eth0'), 'fe80:0:0:0::/64', 'zone id dropped');
  assert.equal(normalizeIp(normalizeIp('2001:db8:1:2::9')), '2001:db8:1:2::/64', 'idempotent');
  assert.equal(normalizeIp('unknown'), 'unknown');
  assert.equal(clientIp({ ip: '2001:db8:1:2::1' }), clientIp({ ip: '2001:db8:1:2:ffff::7' }));
  assert.notEqual(clientIp({ ip: '2001:db8:1:2::1' }), clientIp({ ip: '2001:db8:1:3::1' }));
  assert.equal(clientIp({ ip: '::ffff:203.0.113.9' }), clientIp({ ip: '203.0.113.9' }));
  assert.equal(clientIp({}), 'unknown');
  const l = createLimiter({ limits: [{ windowMs: 60_000, max: 2 }] });
  const a = clientKey({ ip: '2001:db8:1:2::1' });
  assert.equal(l.hit(a), 0);
  assert.equal(l.hit(clientKey({ ip: '2001:db8:1:2:1234:5678:9abc:def0' })), 0);
  assert.ok(l.hit(clientKey({ ip: '2001:db8:1:2::ffff' })) > 0, 'a third address in the same /64 shares the bucket and is limited');
  assert.equal(l.hit(clientKey({ ip: '2001:db8:1:99::1' })), 0, 'another /64 has its own bucket');

  // CIDR matcher
  const yes = (ip: string, cidr: string) => ipInCidr(ip, parseCidr(cidr)!);
  assert.ok(yes('173.245.48.5', '173.245.48.0/20'));
  assert.ok(!yes('173.245.64.1', '173.245.48.0/20'));
  assert.ok(yes('10.1.2.3', '10.0.0.0/8') && !yes('11.0.0.1', '10.0.0.0/8'));
  assert.ok(yes('1.2.3.4', '1.2.3.4') && !yes('1.2.3.5', '1.2.3.4/32'), 'a bare address is a /32');
  assert.ok(yes('2400:cb00:1::1', '2400:cb00::/32') && !yes('2400:cb01::1', '2400:cb00::/32'));
  assert.ok(yes('2606:4700:ffff::1', '2606:4700::/32'));
  assert.ok(yes('::ffff:173.245.48.5', '173.245.48.0/20'), 'a dual-stack socket reports IPv4 peers in mapped form');
  assert.ok(!yes('173.245.48.5', '2400:cb00::/32') && !yes('2400:cb00::1', '10.0.0.0/8'), 'families never match each other');
  assert.ok(yes('1.2.3.4', '0.0.0.0/0') && yes('::1', '::/0'));
  for (const bad of ['', 'abc', '1.2.3.4/33', '1.2.3.4/-1', '::1/129', '1.2.3.4/8/8', '300.1.1.1/8']) assert.equal(parseCidr(bad), null, bad);

  // TRUSTED_CLIENT_IP_HEADER: believed only from a trusted peer
  process.env.TRUSTED_CLIENT_IP_HEADER = 'CF-Connecting-IP';
  process.env.TRUSTED_PROXY_CIDRS = '173.245.48.0/20, 2400:cb00::/32, not-a-cidr';
  const req = (peer: string, header?: string | string[], ip = peer) => ({ ip, socket: { remoteAddress: peer }, headers: header === undefined ? {} : { 'cf-connecting-ip': header } });
  assert.equal(clientIp(req('173.245.48.5', '203.0.113.9')), '203.0.113.9', 'trusted peer: the header is used');
  assert.equal(clientIp(req('::ffff:173.245.48.5', '203.0.113.9')), '203.0.113.9', 'trusted peer seen as IPv4-mapped');
  assert.equal(clientIp(req('2400:cb00:1::7', '2001:db8:5:6::77')), '2001:db8:5:6::/64', 'IPv6 visitor via a trusted IPv6 peer: /64');
  assert.equal(clientIp(req('198.51.100.7', '203.0.113.9')), '198.51.100.7', 'untrusted peer: spoofed header ignored, socket address used');
  assert.equal(clientIp(req('198.51.100.7', '203.0.113.9', '203.0.113.9')), '198.51.100.7', 'even when Express (TRUST_PROXY) would have believed X-Forwarded-For');
  assert.equal(clientIp(req('173.245.48.5')), '173.245.48.5', 'trusted peer without the header: socket address');
  assert.equal(clientIp(req('173.245.48.5', 'garbage')), '173.245.48.5', 'unparseable header: socket address');
  assert.equal(clientIp(req('173.245.48.5', ' 203.0.113.9 ')), '203.0.113.9');
  assert.equal(clientIp({ headers: { 'cf-connecting-ip': '203.0.113.9' } }), 'unknown', 'no socket, nothing to trust');
  delete process.env.TRUSTED_CLIENT_IP_HEADER;
  assert.equal(clientIp(req('173.245.48.5', '203.0.113.9', '192.0.2.44')), '192.0.2.44', 'header unset: req.ip as before (TRUST_PROXY)');
  for (const [k, v] of [['TRUSTED_CLIENT_IP_HEADER', saved.h], ['TRUSTED_PROXY_CIDRS', saved.c]] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  console.log('ok  client address: /64, mapped IPv4, trusted proxy header, CIDR matcher');
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
