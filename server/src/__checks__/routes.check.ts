// Run: npx tsx server/src/__checks__/routes.check.ts   (the accounts part also needs DATABASE_URL=postgres://vulnera:vulnera-dev@127.0.0.1:5432/vulnera_dev)
// Server wiring: with accounts off nothing changes; with accounts on, scans are saved, owned, and the AI budget applies.
import assert from 'node:assert/strict';
import { createKey } from '../apiKeys.js';
import { closeDb, dbEnabled, query } from '../db/pool.js';
import { makeUser, resetDb } from '../db/testdb.js';
import { call, EMPTY_LOCKFILE, sessionCookie, startServer } from './_harness.js';

// ---- accounts off (no DATABASE_URL for the server) ----
{
  const s = await startServer({ DATABASE_URL: '' });
  try {
    const h = await call(s, 'GET', '/api/health');
    assert.equal(h.body.accounts, false);
    const r = await call(s, 'POST', '/api/scan', { body: { lockfile: EMPTY_LOCKFILE } });
    assert.equal(r.status, 200, 'uploads work without an account');
    assert.equal(r.body.scanId, undefined);
    assert.equal(r.headers.get('x-quota-limit'), null, 'no quota headers');
    assert.equal((await call(s, 'POST', '/api/scan', { body: { sample: true } })).status, 200);
    assert.equal((await call(s, 'GET', '/api/scans')).status, 404);
    assert.equal((await call(s, 'GET', '/api/keys')).status, 404);
    assert.equal((await call(s, 'POST', '/v1/scan', { body: { sample: true } })).status, 401, '/v1 needs a key');
    assert.equal((await call(s, 'GET', '/api/scans?key=x')).status, 404, 'no key handling when accounts are off');
    console.log('ok  accounts off: behaves as before');
  } finally {
    await s.stop();
  }
}

if (!dbEnabled()) {
  console.log('SKIP accounts routes checks: DATABASE_URL is not set');
  process.exit(0);
}

let server: Awaited<ReturnType<typeof startServer>> | undefined;
try {
  await resetDb();
  const a = await makeUser();
  const b = await makeUser();
  const ca = await sessionCookie(a.id);
  const cb = await sessionCookie(b.id);
  const { secret: keyA } = await createKey(a.id, 'ci');
  await query("INSERT INTO ai_usage (period, calls, input_tokens, output_tokens) VALUES (date_trunc('month', now() AT TIME ZONE 'Asia/Kolkata')::date, 1, 100000000, 0)");
  server = await startServer({ DATABASE_URL: process.env.DATABASE_URL });
  const s = server;
  assert.equal((await call(s, 'GET', '/api/health')).body.accounts, true);

  // ---- saving: project name, scanId, header, no quotes ----
  const saved = await call(s, 'POST', '/api/scan', { cookie: ca, body: { lockfile: EMPTY_LOCKFILE, meta: { projectName: 'My App' } } });
  assert.equal(saved.status, 200);
  const id = saved.body.scanId as string;
  assert.match(id, /^[0-9a-f-]{36}$/);
  assert.equal(saved.headers.get('x-scan-id'), id);
  assert.equal((await call(s, 'POST', '/api/scan', { cookie: ca, body: { lockfile: EMPTY_LOCKFILE, meta: { projectName: 'x'.repeat(201) } } })).status, 413);
  assert.equal((await call(s, 'POST', '/api/scan', { cookie: ca, body: { lockfile: EMPTY_LOCKFILE, meta: { projectName: 5 } } })).status, 400);
  const own = await call(s, 'GET', `/api/scans/${id}`, { cookie: ca });
  assert.equal(own.status, 200);
  assert.equal(own.body.projectName, 'My App');
  assert.equal(own.headers.get('cache-control'), 'no-store');
  const lst = await call(s, 'GET', '/api/scans?limit=5', { cookie: ca });
  assert.equal(lst.body.scans.length, 1);
  assert.equal(lst.body.nextCursor, null);
  assert.equal((await call(s, 'GET', '/api/scans?cursor=garbage', { cookie: ca })).status, 400);
  console.log('ok  scan saved with scanId + X-Scan-Id; meta.projectName validated');

  // ---- the stream carries scanId in its result message ----
  const st = await fetch(`${s.url}/api/scan/stream`, { method: 'POST', headers: { cookie: ca, origin: 'http://localhost:5173', 'content-type': 'application/json' }, body: JSON.stringify({ lockfile: EMPTY_LOCKFILE }) });
  const lines = (await st.text()).trim().split('\n').map((l) => JSON.parse(l));
  const res = lines.find((l) => l.type === 'result');
  assert.match(res.result.scanId, /^[0-9a-f-]{36}$/);
  console.log('ok  stream result has scanId');

  // ---- another user ----
  for (const [m, p, body] of [['GET', `/api/scans/${id}`], ['DELETE', `/api/scans/${id}`], ['PUT', `/api/scans/${id}/review`, { review: { x: 1 } }]] as const) {
    const r = await call(s, m, p, { cookie: cb, body });
    assert.equal(r.status, 404, `${m} ${p} as user B`);
  }
  assert.equal((await call(s, 'GET', '/api/scans/not-a-uuid', { cookie: ca })).status, 404);
  assert.equal((await call(s, 'GET', '/api/scans', { cookie: cb })).body.scans.length, 0);
  assert.equal((await call(s, 'GET', `/api/scans/${id}`)).status, 401, 'anonymous');
  assert.equal((await call(s, 'PUT', `/api/scans/${id}/review`, { cookie: ca, body: { review: { done: true } } })).status, 200);
  assert.deepEqual((await call(s, 'GET', `/api/scans/${id}`, { cookie: ca })).body.review, { done: true });
  assert.equal((await call(s, 'PUT', `/api/scans/${id}/review`, { cookie: ca, body: { review: { big: 'x'.repeat(70_000) } } })).status, 413);
  assert.equal((await call(s, 'PUT', `/api/scans/${id}/review`, { cookie: ca, body: { review: { big: 'x'.repeat(100_000) } } })).status, 413);
  assert.equal((await call(s, 'PUT', `/api/scans/${id}/review`, { cookie: ca, body: {} })).status, 400);
  assert.equal((await call(s, 'DELETE', `/api/scans/${id}`, { headers: { cookie: ca } })).status, 403, 'CSRF: cookie without a same-origin header');
  console.log('ok  user B: 404 on get/delete/review; anonymous 401; review; csrf');

  // ---- /v1: keys only ----
  assert.equal((await call(s, 'GET', '/v1/scans', { cookie: ca })).status, 401, 'a browser session is not a key');
  const v1 = await call(s, 'GET', '/v1/scans', { key: keyA });
  assert.equal(v1.status, 200);
  assert.equal(v1.body.scans.length, 2);
  assert.equal((await call(s, 'GET', `/v1/scans/${id}`, { key: keyA })).status, 200);
  assert.equal((await call(s, 'PUT', `/v1/scans/${id}/review`, { key: keyA, body: { review: {} } })).status, 401, 'reviews are for sessions');
  const viaKey = await call(s, 'POST', '/v1/scan', { key: keyA, body: { lockfile: EMPTY_LOCKFILE } });
  assert.equal(viaKey.status, 200);
  assert.equal((await query<{ k: string | null }>('SELECT api_key_id::text AS k FROM scans WHERE id = $1', [viaKey.body.scanId]))[0]!.k !== null, true, 'scan remembers the key');
  assert.equal((await call(s, 'POST', '/v1/scan', { body: { sample: true } })).status, 401);
  assert.equal((await call(s, 'POST', '/v1/scan/stream', { cookie: ca, body: { sample: true } })).status, 401);
  assert.equal((await call(s, 'DELETE', `/v1/scans/${id}`, { key: keyA })).status, 200);
  assert.equal((await call(s, 'GET', `/api/scans/${id}`, { cookie: ca })).status, 404);
  const me = (await call(s, 'GET', '/api/health')).body;
  assert.equal(me.ok, true);
  console.log('ok  /v1 routes: key only');

  // ---- Gemini budget exhausted: the AI step is skipped with a note ----
  await s.stop();
  server = await startServer({ DATABASE_URL: process.env.DATABASE_URL, GEMINI_API_KEY: 'test-key-never-called', GEMINI_MONTHLY_BUDGET_INR: '100' }); // 100M tokens = Rs 900
  const paused = await call(server, 'POST', '/api/scan', { body: { sample: true } });
  assert.equal(paused.status, 200, JSON.stringify(paused.body).slice(0, 300));
  assert.equal(paused.body.aiStatus, 'disabled');
  assert.ok(paused.body.notes.includes("AI code check paused: this month's AI budget is used up. Priorities come from the published rules."), JSON.stringify(paused.body.notes));
  const gem = paused.body.agent.find((x: { tool: string }) => x.tool === 'gemini');
  assert.equal(gem.status, 'skipped');
  console.log('ok  AI budget used up: AI step skipped with the note');

  // plan without AI behaves the same way (no budget needed)
  await query('DELETE FROM ai_usage');
  await query("UPDATE plans SET ai_enabled = false WHERE id = 'free'");
  const noAi = await call(server, 'POST', '/api/scan', { cookie: ca, body: { sample: true } });
  assert.equal(noAi.body.aiStatus, 'disabled');
  assert.ok(noAi.body.notes.some((n: string) => /not part of your plan/.test(n)));
  console.log('ok  plan with ai_enabled=false skips the AI step');
} finally {
  await server?.stop();
  await closeDb();
}
