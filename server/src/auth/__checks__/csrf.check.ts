// Run: DATABASE_URL=postgres://vulnera:vulnera-dev@127.0.0.1:5432/vulnera_test npx tsx server/src/auth/__checks__/csrf.check.ts
// The sameOrigin middleware. No queries are made; DATABASE_URL only has to be set for accounts to count as on.
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { sameOrigin } from '../csrf.js';

process.env.DATABASE_URL ||= 'postgres://unused@127.0.0.1:1/unused_test';
Object.assign(process.env, { GITHUB_CLIENT_ID: 'cid', GITHUB_CLIENT_SECRET: 'csecret', PUBLIC_ORIGIN: 'https://vulnera.example' });
const ORIGIN = 'https://vulnera.example';

const app = express();
app.use(sameOrigin);
app.all('/{*any}', (req, res) => res.json({ ok: true, path: req.path }));
const server = app.listen(0, '127.0.0.1');
await new Promise((r) => server.once('listening', r));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

const send = (path: string, headers: Record<string, string> = {}, method = 'POST') => fetch(`${base}${path}`, { method, headers }).then((r) => r.status);
const SID = 'vulnera_sid=abc';
const HOST_SID = '__Host-vulnera_sid=abc';

try {
  const matrix: [string, string, Record<string, string>, number, string?][] = [
    ['cross-site Origin', '/api/me', { origin: 'https://evil.example', cookie: HOST_SID }, 403],
    ['cross-site Origin, no cookie', '/api/scan', { origin: 'https://evil.example' }, 403],
    ['Origin null', '/api/me', { origin: 'null' }, 403],
    ['look-alike Origin', '/api/me', { origin: 'https://vulnera.example.evil.com' }, 403],
    ['Origin with trailing slash', '/api/me', { origin: `${ORIGIN}/` }, 403],
    ['same Origin', '/api/me', { origin: ORIGIN, cookie: HOST_SID }, 200],
    ['Sec-Fetch-Site same-origin', '/api/me', { 'sec-fetch-site': 'same-origin', cookie: HOST_SID }, 200],
    ['Sec-Fetch-Site cross-site', '/api/me', { 'sec-fetch-site': 'cross-site', cookie: HOST_SID }, 403],
    ['Sec-Fetch-Site same-site (sibling subdomain)', '/api/me', { 'sec-fetch-site': 'same-site', origin: 'https://x.vulnera.example', cookie: HOST_SID }, 403],
    ['Sec-Fetch-Site none', '/api/me', { 'sec-fetch-site': 'none', cookie: HOST_SID }, 403],
    ['Bearer header skips the check', '/v1/scan', { authorization: 'Bearer vk_x_y', origin: 'https://evil.example' }, 200],
    ['Bearer with two words does not skip', '/v1/scan', { authorization: 'Bearer a b', origin: 'https://evil.example' }, 403],
    ['"Bearer" with no credential does not skip', '/v1/scan', { authorization: 'Bearer ', origin: 'https://evil.example' }, 403],
    ['Basic auth does not skip', '/api/me', { authorization: 'Basic eDp5', origin: 'https://evil.example' }, 403],
    ['no headers + __Host- session cookie', '/api/me', { cookie: HOST_SID }, 403],
    ['no headers + plain session cookie', '/api/me', { cookie: SID }, 403],
    ['no headers + other cookies only', '/api/me', { cookie: 'vulnera_oauth=x; theme=dark' }, 200],
    ['no headers, no cookie (curl)', '/api/scan', {}, 200],
    ['v1 cross-site', '/v1/scans/1', { origin: 'https://evil.example' }, 403, 'DELETE'],
    ['upper-case path cannot dodge the check', '/API/me', { origin: 'https://evil.example' }, 403],
    ['double slash cannot dodge the check', '//api/me', { origin: 'https://evil.example' }, 403],
    ['GET is never blocked', '/api/me', { origin: 'https://evil.example', cookie: HOST_SID }, 200, 'GET'],
    ['HEAD is never blocked', '/api/me', { origin: 'https://evil.example' }, 200, 'HEAD'],
    ['OPTIONS is never blocked', '/api/me', { origin: 'https://evil.example' }, 200, 'OPTIONS'],
    ['PUT cross-site', '/api/scans/1/review', { 'sec-fetch-site': 'cross-site' }, 403, 'PUT'],
    ['PATCH cross-site', '/api/x', { origin: 'https://evil.example' }, 403, 'PATCH'],
  ];
  for (const [name, path, headers, want, method] of matrix) assert.equal(await send(path, headers, method), want, name);

  const r = await fetch(`${base}/api/me`, { method: 'POST', headers: { origin: 'https://evil.example' } });
  assert.deepEqual(await r.json(), { error: 'This request came from another site and was blocked.' });
  console.log('ok  CSRF matrix with accounts on');

  delete process.env.GITHUB_CLIENT_ID;
  assert.equal(await send('/api/me', { origin: 'https://evil.example', cookie: SID }), 200, 'accounts off: allowed');
  assert.equal(await send('/api/me', { cookie: SID }), 200);
  process.env.GITHUB_CLIENT_ID = 'cid';
  console.log('ok  accounts off: unchanged single-user behaviour');

  process.env.PUBLIC_ORIGIN = 'http://localhost:5173';
  assert.equal(await send('/api/me', { origin: 'http://localhost:5173', cookie: SID }), 200, 'dev origin');
  assert.equal(await send('/api/me', { origin: 'http://localhost:5174', cookie: SID }), 403, 'other port is another origin');
  console.log('ok  plain-http development origin');
  console.log('ALL CSRF CHECKS PASSED');
} finally {
  server.close();
}
