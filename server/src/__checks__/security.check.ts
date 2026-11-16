// Run: npx tsx server/src/__checks__/security.check.ts   (starts a throwaway server on a random local port)
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { doctorAccess, jsonErrorHandler, securityHeaders } from '../security.js';
import { accountsConfigProblems, assertStartupConfig, startupWarnings } from '../startup.js';

const app = express();
app.set('trust proxy', 1);
app.use(securityHeaders);
app.use((req, res, next) => (req.path === '/scanlike' ? next() : express.json({ limit: '1kb' })(req, res, next)));
app.get('/ok', (_req, res) => res.send('ok'));
app.post('/echo', (req, res) => res.json(req.body));
let refunds = 0;
app.post('/scanlike', (_req, res, next) => {
  res.locals.refundScan = async () => void refunds++; // what quota.ts' admit installs
  next();
}, express.json({ limit: '1kb' }), (req, res) => res.json(req.body));
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

  // A8: a body that could not be read gives the quota back; an unrelated error does not
  const scanPost = (body: string) => fetch(`${base}/scanlike`, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
  assert.equal((await scanPost('{nope')).status, 400);
  assert.equal(refunds, 1, 'malformed JSON refunded');
  assert.equal((await scanPost(JSON.stringify({ x: 'a'.repeat(5000) }))).status, 413);
  assert.equal(refunds, 2, 'oversized body refunded');
  assert.equal((await scanPost('{"ok":1}')).status, 200);
  assert.equal(refunds, 2, 'a good request is not refunded by the error handler');
  console.log('ok  400 and 413 refund the scan');
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

// A6: production refuses to start half-configured; development keeps today's behaviour
{
  const prod = { NODE_ENV: 'production', DATABASE_URL: 'postgres://u:p@db.example.com:5432/x', GITHUB_CLIENT_ID: 'id', GITHUB_CLIENT_SECRET: 'secret', PUBLIC_ORIGIN: 'https://vulnera.example.com' } as NodeJS.ProcessEnv;
  assert.deepEqual(accountsConfigProblems(prod), [], 'complete production setup');
  assert.doesNotThrow(() => assertStartupConfig(prod));
  for (const [drop, re] of [['GITHUB_CLIENT_ID', /GITHUB_CLIENT_ID/], ['GITHUB_CLIENT_SECRET', /GITHUB_CLIENT_SECRET/], ['PUBLIC_ORIGIN', /PUBLIC_ORIGIN is missing/]] as const) {
    const env = { ...prod, [drop]: '' };
    assert.throws(() => assertStartupConfig(env), re, `production without ${drop}`);
  }
  assert.throws(() => assertStartupConfig({ ...prod, PUBLIC_ORIGIN: 'http://vulnera.example.com' }), /must be an https/, 'http origin');
  assert.throws(() => assertStartupConfig({ ...prod, PUBLIC_ORIGIN: 'not a url' }), /must be an https/);
  const all = accountsConfigProblems({ NODE_ENV: 'production', DATABASE_URL: 'postgres://x' } as NodeJS.ProcessEnv);
  assert.equal(all.length, 3, 'every missing piece is listed');
  assert.deepEqual(accountsConfigProblems({ NODE_ENV: 'production' } as NodeJS.ProcessEnv), [], 'no DATABASE_URL: accounts are off, nothing to check');
  const dev = { NODE_ENV: 'development', DATABASE_URL: 'postgres://u:p@127.0.0.1:5432/x_dev' } as NodeJS.ProcessEnv;
  assert.deepEqual(accountsConfigProblems(dev), [], 'development with nothing else set passes');
  assert.doesNotThrow(() => assertStartupConfig(dev));
  assert.throws(() => assertStartupConfig({ ...prod, DATABASE_SSL: '0' }), /DATABASE_SSL=0/, 'TLS off for a remote database in production');
  assert.throws(() => assertStartupConfig({ ...prod, DATABASE_CA_FILE: '/no/such/ca.pem' }), /DATABASE_CA_FILE/);
  assert.equal(startupWarnings({ NODE_ENV: 'production', GEMINI_API_KEY: 'k' } as NodeJS.ProcessEnv).length, 1, 'Gemini key without a budget');
  assert.equal(startupWarnings({ NODE_ENV: 'production', GEMINI_API_KEY: 'k', GEMINI_MONTHLY_BUDGET_INR: '500' } as NodeJS.ProcessEnv).length, 0);
  assert.equal(startupWarnings({ NODE_ENV: 'development', GEMINI_API_KEY: 'k' } as NodeJS.ProcessEnv).length, 0);
  console.log('ok  startup configuration checks');
}
console.log('ALL SECURITY CHECKS PASSED');
