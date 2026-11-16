// Run: DATABASE_URL=postgres://vulnera:vulnera-dev@127.0.0.1:5432/vulnera_dev npx tsx server/src/__checks__/quota.check.ts
// Quotas: atomic consume, refund, IST periods, planAndUsage, Gemini budget, and the HTTP gate (before the body is read).
import assert from 'node:assert/strict';
import http from 'node:http';
import { exhausted, record, resetBudgetCache } from '../aiBudget.js';
import { createKey } from '../apiKeys.js';
import { closeDb, dbEnabled, query } from '../db/pool.js';
import { makeUser, resetDb } from '../db/testdb.js';
import { consume, istPeriods, planAndUsage } from '../quota.js';
import { call, ORIGIN, EMPTY_LOCKFILE, headersOnlyPost, sessionCookie, startServer } from './_harness.js';

if (!dbEnabled()) {
  console.log('SKIP quota checks: DATABASE_URL is not set');
  process.exit(0);
}

const usageOf = async (subject: string) => (await query<{ scans: number }>('SELECT scans FROM usage WHERE subject = $1', [subject]))[0]?.scans ?? 0;
let server: Awaited<ReturnType<typeof startServer>> | undefined;
try {
  // ---- periods are Indian months ----
  assert.equal(istPeriods(Date.parse('2026-11-30T18:29:00Z')).month, '2026-11-01');
  assert.equal(istPeriods(Date.parse('2026-11-30T18:31:00Z')).month, '2026-12-01', 'past midnight in India it is already December');
  assert.equal(istPeriods(Date.parse('2026-11-30T18:31:00Z')).monthResets, '2026-12-31T18:30:00.000Z');
  assert.equal(istPeriods(Date.parse('2026-11-16T10:00:00Z')).dayResets, '2026-11-16T18:30:00.000Z');
  console.log('ok  periods follow IST');

  // ---- atomic consume ----
  await resetDb();
  const u = await makeUser();
  const { month } = istPeriods();
  const taken = await Promise.all(Array.from({ length: 20 }, () => consume(`user:${u.id}`, month, u.id, 5, null)));
  assert.equal(taken.filter((t) => t.scans !== null).length, 5, 'exactly 5 of 20 parallel consumes succeed');
  assert.equal(await usageOf(`user:${u.id}`), 5);
  assert.deepEqual(taken.map((t) => t.scans).filter((x) => x !== null).sort(), [1, 2, 3, 4, 5]);
  console.log('ok  20 parallel consumes at limit 5: exactly 5 succeed');

  const ok = taken.find((t) => t.scans !== null)!;
  await ok.refund();
  await ok.refund(); // second call does nothing
  assert.equal(await usageOf(`user:${u.id}`), 4, 'refund gives one back, once');
  assert.notEqual((await consume(`user:${u.id}`, month, u.id, 5, null)).scans, null, 'the refunded scan can be used again');
  const over = await consume(`user:${u.id}`, month, u.id, 5, null);
  assert.equal(over.scans, null);
  await over.refund();
  assert.equal(await usageOf(`user:${u.id}`), 5, 'refunding a refused request changes nothing');
  assert.equal((await consume('user:zero', month, null, 0, null)).scans, null, 'limit 0 refuses everything');
  console.log('ok  refund');

  const k = await consume(`user:${u.id}`, month, u.id, 99, 'key:abc');
  assert.equal(await usageOf('key:abc'), 1, 'key subject is recorded too');
  await k.refund();
  assert.equal(await usageOf('key:abc'), 0);
  assert.equal(await usageOf(`user:${u.id}`), 5);
  console.log('ok  key usage recorded and refunded with the user row');

  // ---- planAndUsage ----
  const pu = await planAndUsage(u.id, '1.2.3.4');
  assert.deepEqual(pu.plan, { id: 'free', name: 'Free', monthlyScans: 30, maxConcurrent: 2, maxApiKeys: 3, aiEnabled: true });
  assert.equal(pu.usage.scans, 5);
  assert.equal(pu.usage.limit, 30);
  assert.equal(pu.usage.period, month);
  const anon = await planAndUsage(null, '1.2.3.4');
  assert.equal(anon.plan.id, 'anonymous');
  assert.equal(anon.usage.limit, 2);
  assert.equal(anon.usage.scans, 0);
  console.log('ok  planAndUsage');

  // ---- Gemini budget ----
  await resetDb();
  process.env.GEMINI_MONTHLY_BUDGET_INR = '10';
  resetBudgetCache();
  assert.equal(await exhausted(), false);
  await record(1_000_000, 0); // Rs 9 at the default rate
  await record(0, 0);
  resetBudgetCache();
  assert.equal(await exhausted(), false, 'Rs 9 of 10');
  const r = (await query<{ calls: number; input_tokens: string }>('SELECT calls, input_tokens::text FROM ai_usage'))[0]!;
  assert.deepEqual([r.calls, r.input_tokens], [2, '1000000']);
  await record(0, 100_000); // Rs 3.6 more
  assert.equal(await exhausted(), false, 'cached for 60 s');
  resetBudgetCache();
  assert.equal(await exhausted(), true, 'Rs 12.6 of 10');
  process.env.GEMINI_MONTHLY_BUDGET_INR = '0';
  resetBudgetCache();
  assert.equal(await exhausted(), false, '0 = no cap');
  console.log('ok  AI budget');

  // A4: the budget cannot be read. Cold start with a cap: assume it is used up. With a value already known: keep it.
  process.env.GEMINI_MONTHLY_BUDGET_INR = '10';
  await query('DELETE FROM ai_usage');
  await query('ALTER TABLE ai_usage RENAME TO ai_usage_gone');
  const realErr = console.error;
  const logged: string[] = [];
  console.error = (...a: unknown[]) => void logged.push(a.join(' '));
  try {
    resetBudgetCache();
    assert.equal(await exhausted(), true, 'cold start + database error + a cap: fail closed');
    await record(5, 5); // must not throw
    await record(5, 5);
    assert.equal(logged.length, 1, `write and read failures are logged once per 10 minutes (got ${logged.length})`);
    process.env.GEMINI_MONTHLY_BUDGET_INR = '0';
    resetBudgetCache();
    assert.equal(await exhausted(), false, 'no cap: never exhausted, even with the database down');
    process.env.GEMINI_MONTHLY_BUDGET_INR = '10';
    await query('ALTER TABLE ai_usage_gone RENAME TO ai_usage');
    resetBudgetCache();
    assert.equal(await exhausted(), false, 'a successful read is remembered');
    await query('ALTER TABLE ai_usage RENAME TO ai_usage_gone');
    const realNow = Date.now;
    Date.now = () => realNow() + 120_000; // the 60 s cache has expired
    try {
      assert.equal(await exhausted(), false, 'database error with a known value: keep using it');
    } finally {
      Date.now = realNow;
    }
  } finally {
    console.error = realErr;
    await query('ALTER TABLE ai_usage_gone RENAME TO ai_usage');
    process.env.GEMINI_MONTHLY_BUDGET_INR = '0';
    resetBudgetCache();
  }
  console.log('ok  AI budget fails closed on a cold-start database error');

  // ---- the HTTP gate ----
  await resetDb();
  const a = await makeUser();
  const cookie = await sessionCookie(a.id);
  const { secret } = await createKey(a.id, 'ci');
  await query("UPDATE plans SET monthly_scans = 2 WHERE id = 'free'");
  server = await startServer({ DATABASE_URL: process.env.DATABASE_URL });
  const s = server;
  const scan = (o: object) => call(s, 'POST', '/api/scan', { body: { lockfile: EMPTY_LOCKFILE }, ...o });

  const first = await scan({ cookie });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(first.headers.get('x-quota-limit'), '2');
  assert.equal(first.headers.get('x-quota-remaining'), '1');
  assert.ok(first.body.scanId && first.headers.get('x-scan-id') === first.body.scanId, 'scanId in the body and X-Scan-Id');
  const viaKey = await call(s, 'POST', '/v1/scan', { key: secret, body: { lockfile: EMPTY_LOCKFILE } });
  assert.equal(viaKey.status, 200);
  assert.equal(viaKey.headers.get('x-quota-remaining'), '0', 'keys share the user plan');
  assert.equal(await usageOf(`key:${(await query<{ id: string }>('SELECT id FROM api_keys'))[0]!.id}`), 1, 'key row counted too');
  console.log('ok  signed-in scans count against the plan; keys share it');

  const blocked = await scan({ cookie });
  assert.equal(blocked.status, 429);
  assert.equal(blocked.body.code, 'quota_exceeded');
  assert.match(blocked.body.error, /resets on \d+ \w+ \(IST\)/);
  const t = await headersOnlyPost(s, '/api/scan', { cookie, origin: 'http://localhost:5173' }, 9 * 1024 * 1024);
  assert.equal(t.status, 429, '9 MB body, over quota');
  assert.ok(t.ms < 1500, `answered without reading the body (${t.ms} ms)`);
  assert.equal(JSON.parse(t.body).code, 'quota_exceeded');
  console.log('ok  over quota: 429 before the body is read');

  const sample = await call(s, 'POST', '/api/scan', { cookie, body: { sample: true } });
  assert.equal(sample.status, 200, 'the sample still works when the quota is used up');
  assert.equal(sample.body.scanId, undefined, 'samples are not saved');
  assert.equal((await query('SELECT 1 FROM scans')).length, 2);
  console.log('ok  sample: not counted, not saved, allowed over quota');

  // refunds: validation failure and a scan error give the scan back
  await query("UPDATE usage SET scans = 0 WHERE subject LIKE 'user:%'");
  assert.equal((await call(s, 'POST', '/api/scan', { cookie, body: { lockfile: EMPTY_LOCKFILE, sources: 'nope' } })).status, 400);
  assert.equal((await call(s, 'POST', '/api/scan', { cookie, body: {} })).status, 400);
  assert.equal(await usageOf(`user:${a.id}`), 0, 'validation failures are refunded');
  assert.equal((await call(s, 'POST', '/api/scan', { cookie, body: { sample: true } })).status, 200);
  assert.equal(await usageOf(`user:${a.id}`), 0, 'a sample is refunded');
  assert.equal((await call(s, 'POST', '/api/scan', { cookie, body: { lockfile: { lockfileVersion: 1 } } })).status, 400);
  assert.equal(await usageOf(`user:${a.id}`), 0, 'a lockfile that cannot be read is refunded');
  assert.equal((await scan({ cookie })).status, 200);
  assert.equal(await usageOf(`user:${a.id}`), 1, 'a delivered result is kept');
  console.log('ok  refunds: validation, sample, scan error');

  // A8: a body that cannot be read keeps no quota: malformed JSON, too large, aborted mid-upload
  await query("UPDATE usage SET scans = 0 WHERE subject LIKE 'user:%'");
  const raw = (body: string) => fetch(`${s.url}/api/scan`, { method: 'POST', headers: { cookie, origin: ORIGIN, 'content-type': 'application/json' }, body });
  const malformed = await raw('{"lockfile": nope');
  assert.equal(malformed.status, 400);
  assert.equal(await usageOf(`user:${a.id}`), 0, 'malformed JSON (400) leaves usage unchanged');
  const huge = await raw(`{"lockfile":{"pad":"${'x'.repeat(11 * 1024 * 1024)}"}}`);
  assert.equal(huge.status, 413);
  assert.equal(await usageOf(`user:${a.id}`), 0, 'oversized body (413) leaves usage unchanged');
  await new Promise<void>((resolve) => {
    const req = http.request({ host: '127.0.0.1', port: s.port, path: '/api/scan', method: 'POST', headers: { cookie, origin: ORIGIN, 'content-type': 'application/json', 'content-length': '5000' } });
    req.on('error', () => {});
    req.write('{"lockfile":');
    setTimeout(() => (req.destroy(), resolve()), 300); // by now the quota was taken; the client leaves
  });
  for (let i = 0; i < 40 && (await usageOf(`user:${a.id}`)) !== 0; i++) await new Promise((r) => setTimeout(r, 50));
  assert.equal(await usageOf(`user:${a.id}`), 0, 'an upload aborted before the scan started leaves usage unchanged');
  console.log('ok  400, 413 and an aborted upload do not cost a scan');

  // ---- anonymous with accounts on ----
  await query('DELETE FROM usage');
  const anon1 = await call(s, 'POST', '/api/scan', { body: { repoUrl: 'not a repo' } });
  assert.ok([400, 502].includes(anon1.status), String(anon1.status));
  const ipRows = await query<{ subject: string }>("SELECT subject FROM usage WHERE subject LIKE 'ip:%'");
  assert.equal(ipRows.length, 1, 'an anonymous scan is counted per IP');
  await query("UPDATE usage SET scans = 2 WHERE subject LIKE 'ip:%'"); // two repo scans done today
  const third = await call(s, 'POST', '/api/scan', { body: { repoUrl: 'owner/repo' } });
  assert.equal(third.status, 429);
  assert.equal(third.body.code, 'quota_exceeded');
  assert.match(third.body.error, /midnight/);
  assert.equal((await call(s, 'POST', '/api/scan', { body: { sample: true } })).status, 200, 'the sample is always free');
  const big = await call(s, 'POST', '/api/scan', { body: { lockfile: { ...EMPTY_LOCKFILE, pad: 'x'.repeat(5000) } } });
  assert.equal(big.status, 401);
  assert.equal(big.body.code, 'signin_required');
  assert.equal(big.body.error, 'Sign in to upload a lockfile.');
  const small = await call(s, 'POST', '/api/scan', { body: { lockfile: EMPTY_LOCKFILE } });
  assert.equal(small.status, 429, 'over quota wins over the small lockfile');
  await query("UPDATE usage SET scans = 0 WHERE subject LIKE 'ip:%'");
  const small2 = await call(s, 'POST', '/api/scan', { body: { lockfile: EMPTY_LOCKFILE } });
  assert.equal(small2.status, 401, 'even a tiny lockfile needs an account');
  assert.equal(small2.body.code, 'signin_required');
  assert.equal((await query<{ scans: number }>("SELECT scans FROM usage WHERE subject LIKE 'ip:%'"))[0]!.scans, 0, 'and the quota is given back');
  const t2 = await headersOnlyPost(s, '/api/scan', {}, 9 * 1024 * 1024);
  assert.equal(t2.status, 401);
  assert.ok(t2.ms < 1500);
  console.log('ok  anonymous: third repo scan 429, lockfile 401, sample free');
} finally {
  await server?.stop();
  await closeDb();
}
