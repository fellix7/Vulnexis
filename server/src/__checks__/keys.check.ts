// Run: DATABASE_URL=postgres://vulnera:vulnera-dev@127.0.0.1:5432/vulnera_dev npx tsx server/src/__checks__/keys.check.ts
// API keys: hash only, shown once, revoke, plan limit, Bearer-only, failed lookups rate limited.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createKey, KeyLimitError, listKeys, revokeKey, verifyKey } from '../apiKeys.js';
import { closeDb, dbEnabled, query } from '../db/pool.js';
import { makeUser, resetDb } from '../db/testdb.js';
import { call, sessionCookie, startServer } from './_harness.js';

if (!dbEnabled()) {
  console.log('SKIP keys checks: DATABASE_URL is not set');
  process.exit(0);
}

let server: Awaited<ReturnType<typeof startServer>> | undefined;
try {
  // ---- storage ----
  await resetDb();
  const u = await makeUser();
  const { key, secret } = await createKey(u.id, 'ci');
  assert.match(secret, /^vk_[0-9a-f]{16}_[A-Za-z0-9_-]{43}$/);
  assert.equal(key.last4, secret.slice(-4));
  const row = (await query<{ key_hash: Buffer; key_id: string; txt: string }>('SELECT key_hash, key_id, k::text AS txt FROM api_keys k'))[0]!;
  assert.deepEqual(row.key_hash, createHash('sha256').update(secret).digest(), 'sha256 of the whole key');
  assert.equal(row.key_id, secret.split('_')[1]);
  assert.ok(!row.txt.includes(secret.split('_')[2]!), 'the secret part is nowhere in the row');
  assert.ok(!JSON.stringify(await listKeys(u.id)).includes(secret.split('_')[2]!), 'list never returns the secret');
  console.log('ok  key stored as sha256 only; format; list hides the secret');

  const v = await verifyKey(secret);
  assert.equal(v?.userId, u.id);
  assert.equal(v?.planId, 'free');
  const t1 = (await query<{ t: Date }>('SELECT last_used_at AS t FROM api_keys'))[0]!.t;
  await new Promise((r) => setTimeout(r, 100));
  await verifyKey(secret);
  assert.equal((await query<{ t: Date }>('SELECT last_used_at AS t FROM api_keys'))[0]!.t.getTime(), t1.getTime(), 'last_used_at is touched at most once a minute');
  const wrong = `vk_${secret.split('_')[1]}_${'A'.repeat(43)}`;
  assert.equal(await verifyKey(wrong), null, 'right id, wrong secret');
  for (const bad of ['', 'vk_', 'vk_zzzz_abc', secret + 'x', secret.slice(0, -1), secret.replace('vk_', 'vx_')]) assert.equal(await verifyKey(bad), null, bad);
  const other = await makeUser();
  assert.equal(await revokeKey(other.id, key.id), false, 'another user cannot revoke it');
  assert.equal(await revokeKey(u.id, 'not-a-uuid'), false);
  assert.equal(await revokeKey(u.id, key.id), true);
  assert.equal(await verifyKey(secret), null, 'revoked key is refused');
  assert.equal((await listKeys(u.id)).length, 0);
  console.log('ok  verify: wrong/malformed/revoked refused; last_used_at throttled');

  for (let i = 0; i < 3; i++) await createKey(u.id, `k${i}`);
  await assert.rejects(createKey(u.id, 'k4'), KeyLimitError, 'free plan allows 3');
  const results = await Promise.allSettled(Array.from({ length: 6 }, () => createKey(other.id, 'race')));
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 3, 'parallel creates cannot pass the limit');
  console.log('ok  plan key limit holds, also under parallel creates');

  // ---- over HTTP ----
  await resetDb();
  const a = await makeUser();
  const cookie = await sessionCookie(a.id);
  server = await startServer({ DATABASE_URL: process.env.DATABASE_URL });
  const s = server;
  assert.equal((await call(s, 'GET', '/api/keys')).status, 401, 'keys need a session');
  assert.equal((await call(s, 'POST', '/api/keys', { cookie, body: { name: '' } })).status, 400);
  const made = await call(s, 'POST', '/api/keys', { cookie, body: { name: 'laptop' } });
  assert.equal(made.status, 201);
  assert.match(made.body.secret, /^vk_/);
  const listed = await call(s, 'GET', '/api/keys', { cookie });
  assert.equal(listed.body.keys.length, 1);
  assert.ok(!JSON.stringify(listed.body).includes(made.body.secret), 'the secret is shown once');
  assert.equal(listed.body.keys[0].last4, made.body.secret.slice(-4));
  assert.equal((await call(s, 'POST', '/api/keys', { key: made.body.secret, body: { name: 'x' } })).status, 401, 'a key cannot mint keys');
  console.log('ok  POST/GET /api/keys: secret once, hidden in the list');

  const good = await call(s, 'GET', '/api/scans', { key: made.body.secret });
  assert.equal(good.status, 200);
  assert.equal(good.headers.get('cache-control'), 'no-store');
  const viaUrl = await call(s, 'GET', `/api/scans?api_key=${made.body.secret}`);
  assert.equal(viaUrl.status, 400, 'key in the URL');
  for (const p of ['key', 'token']) assert.equal((await call(s, 'GET', `/api/scans?${p}=x`)).status, 400);
  assert.equal((await call(s, 'GET', '/api/scans', { key: 'vk_nonsense' })).status, 401);
  const del = await call(s, 'DELETE', `/api/keys/${made.body.key.id}`, { cookie });
  assert.equal(del.status, 200);
  const revoked = await call(s, 'GET', '/api/scans', { key: made.body.secret });
  assert.equal(revoked.status, 401);
  assert.equal(revoked.body.error, 'This API key is not valid.');
  assert.equal((await call(s, 'DELETE', `/api/keys/${made.body.key.id}`, { cookie })).status, 404, 'already revoked');
  assert.equal((await call(s, 'DELETE', '/api/keys/nope', { cookie })).status, 404);
  console.log('ok  Bearer works; revoked/malformed 401; key in URL 400');

  // 4th key would be over the free limit
  for (let i = 0; i < 3; i++) assert.equal((await call(s, 'POST', '/api/keys', { cookie, body: { name: `k${i}` } })).status, 201);
  assert.equal((await call(s, 'POST', '/api/keys', { cookie, body: { name: 'k3' } })).status, 409);
  console.log('ok  POST /api/keys: 409 at max_api_keys');

  // A14: key names are printable text, 1 to 60 characters
  const cookieNames = cookie;
  for (const bad of ['', '   ', 'x'.repeat(61), 'two\nlines', 'tab\there', 'nul\u0000', 'bidi\u202eoverride', 'zero\u200bwidth', 'lone\ud800surrogate', 5, null, ['a']]) {
    assert.equal((await call(s, 'POST', '/api/keys', { cookie: cookieNames, body: { name: bad } })).status, 400, JSON.stringify(bad));
  }
  await query('UPDATE api_keys SET revoked_at = now()');
  assert.equal((await call(s, 'POST', '/api/keys', { cookie: cookieNames, body: { name: 'Laptop – CI ✓ (नाम) 日本' } })).status, 201, 'printable unicode is fine');
  assert.equal((await call(s, 'POST', '/api/keys', { cookie: cookieNames, body: { name: 'x'.repeat(60) } })).status, 201, '60 characters is fine');
  console.log('ok  key names: printable only, 1 to 60');

  // A2: at most 10 key creations per user per hour, whatever the plan allows
  await query("UPDATE plans SET max_api_keys = 100 WHERE id = 'free'");
  const rl = await makeUser();
  const rlCookie = await sessionCookie(rl.id);
  for (let i = 0; i < 10; i++) assert.equal((await call(s, 'POST', '/api/keys', { cookie: rlCookie, body: { name: `k${i}` } })).status, 201, `create ${i + 1}`);
  const eleventh = await call(s, 'POST', '/api/keys', { cookie: rlCookie, body: { name: 'k10' } });
  assert.equal(eleventh.status, 429, 'the 11th creation in an hour');
  assert.ok(Number(eleventh.headers.get('retry-after')) > 0, 'Retry-After says when to try again');
  assert.equal((await query('SELECT 1 FROM api_keys WHERE user_id = $1', [rl.id])).length, 10, 'and no key was made');
  const innocent = await makeUser();
  assert.equal((await call(s, 'POST', '/api/keys', { cookie: await sessionCookie(innocent.id), body: { name: 'mine' } })).status, 201, 'the limit is per user');
  console.log('ok  key creation: 11th in an hour is 429, per user');

  // A9: a valid key is never blocked by earlier failures from the same address; only failures are counted
  // failed lookups are limited per IP (default 20 a minute); do this last, it locks the test address out of key logins
  let limited = 0;
  for (let i = 0; i < 30; i++) if ((await call(s, 'GET', '/api/scans', { key: 'vk_bad' })).status === 429) limited++;
  assert.ok(limited >= 9, `failed lookups rate limited (got ${limited})`);
  const { secret: goodSecret } = await createKey(innocent.id, 'after-the-storm');
  const stillGood = await call(s, 'GET', '/api/scans', { key: goodSecret });
  assert.equal(stillGood.status, 200, 'a valid key still works from an address that is over the failure limit');
  assert.equal((await call(s, 'GET', '/api/scans', { key: 'vk_bad' })).status, 429, 'while bad keys stay blocked');
  console.log('ok  failed key lookups are rate limited per IP');
} finally {
  await server?.stop();
  await closeDb();
}
