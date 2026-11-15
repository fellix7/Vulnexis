// Run: npx tsx server/src/__checks__/security.check.ts   (starts a throwaway server on a random local port)
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { doctorAccess, jsonErrorHandler, securityHeaders } from '../security.js';

const app = express();
app.set('trust proxy', 1);
app.use(securityHeaders);
app.use(express.json({ limit: '1kb' }));
app.get('/ok', (_req, res) => res.send('ok'));
app.post('/echo', (req, res) => res.json(req.body));
app.get('/boom', () => {
  throw new Error('secret internal detail at /srv/app.ts:1');
});
app.use(jsonErrorHandler);
const server = app.listen(0);
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const post = (body: string) => fetch(`${base}/echo`, { method: 'POST', headers: { 'content-type': 'application/json' }, body });

try {
  const r = await fetch(`${base}/ok`);
  for (const h of ['content-security-policy', 'x-content-type-options', 'referrer-policy', 'permissions-policy', 'cross-origin-opener-policy']) {
    assert.ok(r.headers.get(h), h);
  }
  assert.match(r.headers.get('content-security-policy')!, /default-src 'self'.*frame-ancestors 'none'/);
  assert.equal(r.headers.get('strict-transport-security'), null, 'no HSTS over plain http');
  const s = await fetch(`${base}/ok`, { headers: { 'x-forwarded-proto': 'https' } });
  assert.match(s.headers.get('strict-transport-security')!, /max-age=/, 'HSTS when the request is secure (trusted proxy)');
  console.log('ok  security headers');

  const bad = await post('{nope');
  assert.equal(bad.status, 400);
  assert.deepEqual(await bad.json(), { error: 'The request body is not valid JSON.' });
  const big = await post(JSON.stringify({ x: 'a'.repeat(5000) }));
  assert.equal(big.status, 413);
  assert.deepEqual(await big.json(), { error: 'The upload is too large (limit 10 MB).' });
  const boom = await fetch(`${base}/boom`);
  assert.equal(boom.status, 500);
  const text = await boom.text();
  assert.deepEqual(JSON.parse(text), { error: 'Something went wrong on our side. Please try again.' });
  assert.ok(!text.includes('secret'));
  console.log('ok  JSON error handler');
} finally {
  server.close();
}

// /api/doctor access rules
const req = (token?: string, ip = '203.0.113.9', fwd?: string) =>
  ({ get: (h: string) => (h === 'x-admin-token' ? token : h === 'x-forwarded-for' ? fwd : undefined), socket: { remoteAddress: ip } }) as never;
const saved = { env: process.env.NODE_ENV, tok: process.env.ADMIN_TOKEN };
process.env.NODE_ENV = 'development';
assert.equal(doctorAccess(req()), 'ok');
process.env.NODE_ENV = 'production';
delete process.env.ADMIN_TOKEN;
assert.equal(doctorAccess(req('x')), 'not-found');
process.env.ADMIN_TOKEN = 's3cret';
assert.equal(doctorAccess(req()), 'forbidden');
assert.equal(doctorAccess(req('wrong')), 'forbidden');
assert.equal(doctorAccess(req('s3cret')), 'ok');
delete process.env.ADMIN_TOKEN;
assert.equal(doctorAccess(req(undefined, '127.0.0.1')), 'ok', 'own computer, no proxy');
assert.equal(doctorAccess(req(undefined, '::1')), 'ok');
assert.equal(doctorAccess(req(undefined, '127.0.0.1', '198.51.100.7')), 'not-found', 'forwarded by a proxy: not local');
process.env.TRUST_PROXY = '1';
assert.equal(doctorAccess(req(undefined, '127.0.0.1')), 'not-found', 'behind a configured proxy: not local');
delete process.env.TRUST_PROXY;
process.env.NODE_ENV = saved.env;
if (saved.tok === undefined) delete process.env.ADMIN_TOKEN;
else process.env.ADMIN_TOKEN = saved.tok;
console.log('ok  doctor access');
console.log('ALL SECURITY CHECKS PASSED');
