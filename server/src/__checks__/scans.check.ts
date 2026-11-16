// Run: DATABASE_URL=postgres://vulnera:vulnera-dev@127.0.0.1:5432/vulnera_dev npx tsx server/src/__checks__/scans.check.ts
// Saved scans: no source code stored, 2 MB cap, ownership, keyset pagination, review limit, sweep.
import assert from 'node:assert/strict';
import { closeDb, dbEnabled, query } from '../db/pool.js';
import { makeUser, resetDb } from '../db/testdb.js';
import { BadCursorError, get, list, putReview, remove, ReviewTooBigError, reviewProblem, save, stripQuotes } from '../scansStore.js';
import { sweepOnce } from '../sweep.js';
import type { Finding, ScanResult } from '../types.js';

if (!dbEnabled()) {
  console.log('SKIP scans checks: DATABASE_URL is not set');
  process.exit(0);
}

const SECRET = 'const apiKey = "SUPER_SECRET_SOURCE_LINE";';
const finding = (i: number, details = 'd', tier: Finding['tier'] = 'PLAN'): Finding => ({
  pkg: { name: `p${i}`, version: '1.0.0', direct: true, dev: false, path: [] },
  advisory: { id: `GHSA-${i}`, aliases: [], summary: 's', details, severity: 'HIGH', fixedVersions: [], references: [] },
  enrichment: { epss: null, kev: null },
  tier,
  reasons: [],
  ai: { verdict: 'USES_VULNERABLE_API', reasoning: 'r', citations: [{ file: 'src/a.js', line: 7, quote: SECRET }] },
  exposure: { level: 'public', ssvc: 'open', via: [], reason: 'r', lowered: false, evidence: [{ file: 'src/server.js', line: 3, quote: SECRET }] },
});
const result = (n = 2, over: Partial<ScanResult> = {}): ScanResult => ({
  scannedAt: new Date().toISOString(),
  packageCount: 10,
  findings: Array.from({ length: n }, (_, i) => finding(i, 'd', i === 0 ? 'FIX_NOW' : 'PLAN')),
  plans: [],
  aiStatus: 'ok',
  notes: [],
  agent: [{ id: 's1', tool: 'plan', title: 't', status: 'done', startedAt: 0 }],
  ...over,
});

try {
  await resetDb();
  const a = await makeUser();
  const b = await makeUser();

  // ---- no source code in the stored scan ----
  const live = result();
  const id = (await save(a.id, null, 'repo', 'acme/web', live))!;
  assert.ok(id);
  const raw = (await query<{ txt: string; rj: any; bytes: number; pc: number; fc: number; fn: number; exp: Date; cr: Date }>(
    'SELECT result::text AS txt, result AS rj, result_bytes AS bytes, package_count AS pc, finding_count AS fc, fix_now_count AS fn, expires_at AS exp, created_at AS cr FROM scans',
  ))[0]!;
  assert.ok(!raw.txt.includes('SUPER_SECRET'), 'no quote text in the stored JSON');
  const cite = raw.rj.findings[0].ai.citations[0];
  assert.deepEqual([cite.file, cite.line, cite.quote, cite.quoteStored], ['src/a.js', 7, '', false]);
  assert.equal(raw.rj.findings[0].exposure.evidence[0].quote, '');
  // A16: no AI free text either; verdict, file and line stay
  const stored = raw.rj.findings[0].ai;
  assert.deepEqual([stored.verdict, stored.reasoning, stored.reasoningStored], ['USES_VULNERABLE_API', '', false]);
  assert.ok(!raw.txt.includes('"reasoning": "r"'), 'no AI reasoning text in the stored JSON');
  assert.equal(live.findings[0]!.ai!.reasoning, 'r', 'the live result keeps its reasoning');
  assert.equal(raw.rj.findings[0].exposure.evidence[0].line, 3);
  assert.equal(live.findings[0]!.ai!.citations[0]!.quote, SECRET, 'the live result keeps its quotes');
  assert.deepEqual([raw.pc, raw.fc, raw.fn], [10, 2, 1]);
  assert.equal(raw.bytes, Buffer.byteLength(raw.txt.replace(/": /g, '":').length ? JSON.stringify(raw.rj) : ''), 'result_bytes matches');
  const days = (raw.exp.getTime() - raw.cr.getTime()) / 86_400_000;
  assert.ok(days > 89.9 && days < 90.1, `expires in 90 days (${days})`);
  assert.deepEqual(stripQuotes({ a: [{ quote: 'x', n: 1 }] }), { a: [{ quote: '', n: 1, quoteStored: false }] });
  assert.deepEqual(stripQuotes({ ai: { verdict: 'UNCERTAIN', reasoning: 'free text', citations: [{ file: 'a.js', line: 2, quote: 'q' }] } }), {
    ai: { verdict: 'UNCERTAIN', reasoning: '', reasoningStored: false, citations: [{ file: 'a.js', line: 2, quote: '', quoteStored: false }] },
  });
  const got = (await get(a.id, id))!;
  assert.equal(got.result.scanId, id);
  assert.equal(got.projectName, 'acme/web');
  assert.deepEqual(got.review, {});
  console.log('ok  quotes stripped (file and line kept), counts and 90-day expiry');

  // ---- 2 MB cap ----
  const bigAgent = result(1, { agent: Array.from({ length: 4000 }, (_, i) => ({ id: `s${i}`, tool: 'osv' as const, title: 'x'.repeat(600), status: 'done' as const, startedAt: i })) });
  const id2 = (await save(a.id, null, 'upload', 'big agent', bigAgent))!;
  const r2 = (await query<{ r: ScanResult; b: number }>('SELECT result AS r, result_bytes AS b FROM scans WHERE id = $1', [id2]))[0]!;
  assert.equal(r2.r.agent, undefined, 'agent steps dropped first');
  assert.ok(r2.b <= 2 * 1024 * 1024);
  assert.ok(r2.r.notes.some((n) => /agent steps/.test(n)));
  const bigDetails = result(0, { findings: Array.from({ length: 12 }, (_, i) => finding(i, 'y'.repeat(250_000))) });
  const id3 = (await save(a.id, null, 'upload', 'big details', bigDetails))!;
  const r3 = (await query<{ r: ScanResult; b: number }>('SELECT result AS r, result_bytes AS b FROM scans WHERE id = $1', [id3]))[0]!;
  assert.ok(r3.b <= 2 * 1024 * 1024);
  assert.ok(r3.r.findings[0]!.advisory.details.length < 500, 'details trimmed');
  assert.equal(r3.r.findings.length, 12, 'findings themselves are kept');
  const hopeless = result(0, { findings: Array.from({ length: 3000 }, (_, i) => finding(i)), notes: ['n'.repeat(2_200_000)] });
  assert.equal(await save(a.id, null, 'upload', 'hopeless', hopeless), null, 'still too big: not saved');
  console.log('ok  2 MB cap: agent dropped, details trimmed, hopeless skipped');

  // ---- ownership ----
  assert.equal(await get(b.id, id), null);
  assert.equal(await remove(b.id, id), false);
  assert.equal(await putReview(b.id, id, { x: 1 }), false);
  assert.ok(await get(a.id, id), 'still there');
  assert.equal(await get(a.id, 'not-a-uuid'), null);
  assert.equal(await remove(a.id, 'nope'), false);
  assert.equal(await putReview(a.id, 'nope', {}), false);
  assert.equal(await putReview(a.id, id, { notes: 'fixed in sprint 4' }), true);
  assert.deepEqual((await get(a.id, id))!.review, { notes: 'fixed in sprint 4' });
  await assert.rejects(putReview(a.id, id, { big: 'x'.repeat(70_000) }), ReviewTooBigError);
  assert.equal(await putReview(a.id, id, { ok: 'x'.repeat(60_000) }), true, 'just under 64 KB');
  assert.equal(await remove(a.id, id3), true);
  assert.equal(await get(a.id, id3), null);
  console.log('ok  other users get nothing; malformed ids are plain misses; review limit');

  // ---- pagination (equal timestamps included) ----
  await resetDb();
  const c = await makeUser();
  const ids: string[] = [];
  for (let i = 0; i < 7; i++) ids.push((await save(c.id, null, 'upload', `p${i}`, result(1)))!);
  await query("UPDATE scans SET created_at = '2026-01-01T00:00:00.123456Z' WHERE project_name IN ('p2','p3','p4')"); // a tie spanning a page boundary
  await query("UPDATE scans SET created_at = '2026-01-02T00:00:00Z' WHERE project_name IN ('p0')");
  const all = (await query<{ id: string }>('SELECT id FROM scans WHERE user_id = $1 ORDER BY created_at DESC, id DESC', [c.id])).map((r) => r.id);
  const seen: string[] = [];
  let cursor: string | undefined;
  let pages = 0;
  do {
    const page = await list(c.id, 3, cursor);
    seen.push(...page.scans.map((s) => s.id));
    cursor = page.nextCursor ?? undefined;
    pages++;
  } while (cursor);
  assert.deepEqual(seen, all, 'every scan once, in order, across pages');
  assert.equal(pages, 3);
  assert.equal((await list(c.id, 500)).scans.length, 7, 'limit is capped at 50');
  assert.equal((await list(c.id, 1)).scans.length, 1);
  assert.equal((await list(b.id, 20)).scans.length, 0, 'only your own scans');
  assert.ok(/^[A-Za-z0-9_-]+$/.test((await list(c.id, 3)).nextCursor!), 'opaque url-safe cursor');
  await assert.rejects(list(c.id, 3, '!!!'), BadCursorError);
  await assert.rejects(list(c.id, 3, Buffer.from('["x","y"]').toString('base64url')), BadCursorError);
  const goodId = '00000000-0000-4000-8000-000000000001';
  for (const ts of ['2026-13-01T00:00:00.000000Z', '2026-02-31T00:00:00.000000Z', '2026-01-01T25:00:00.000000Z', '9999-99-99T99:99:99.999999Z', '2026-01-01', 'now']) {
    await assert.rejects(list(c.id, 3, Buffer.from(JSON.stringify([ts, goodId])).toString('base64url')), BadCursorError, ts);
  }
  await assert.rejects(list(c.id, 3, Buffer.from(JSON.stringify(['2026-01-01T00:00:00.000000Z', 'not-a-uuid'])).toString('base64url')), BadCursorError, 'bad id');
  await assert.rejects(list(c.id, 3, Buffer.from(JSON.stringify(['2026-01-01T00:00:00.000000Z', goodId, 'extra'])).toString('base64url')), BadCursorError, 'extra element');
  assert.ok(Array.isArray((await list(c.id, 3, Buffer.from(JSON.stringify(['2026-01-01T00:00:00.000000Z', goodId])).toString('base64url'))).scans), 'a well-formed cursor works');
  const sum = (await list(c.id, 1)).scans[0]!;
  assert.deepEqual(Object.keys(sum).sort(), ['aiStatus', 'createdAt', 'expiresAt', 'findingCount', 'fixNowCount', 'id', 'packageCount', 'projectName', 'source']);
  console.log('ok  keyset pagination: ties, cap, cursor validation');

  // ---- sweep ----
  await query("UPDATE scans SET expires_at = now() - interval '1 minute' WHERE project_name = 'p1'");
  await query(`INSERT INTO sessions (id_hash, user_id, expires_at) VALUES ('\\x01', $1, now() - interval '1 day'), ('\\x02', $1, now() + interval '1 day')`, [c.id]);
  await query(`INSERT INTO usage (subject, period, scans) VALUES ('ip:old', current_date - 5, 1), ('ip:new', current_date, 1), ('user:keep', current_date - 5, 1)`);
  assert.equal((await list(c.id, 50)).scans.length, 6, 'expired scans are hidden even before the sweep');
  const swept = await sweepOnce();
  assert.deepEqual(swept, { scans: 1, sessions: 1, keys: 0, ipUsage: 1 });
  assert.equal((await query('SELECT 1 FROM usage')).length, 2);
  // A16: IP rows from before yesterday go, yesterday's stay; A11: keys revoked over 30 days ago are purged
  await query(`INSERT INTO usage (subject, period, scans) VALUES ('ip:two', (now() AT TIME ZONE 'Asia/Kolkata')::date - 2, 1), ('ip:one', (now() AT TIME ZONE 'Asia/Kolkata')::date - 1, 1)`);
  await query(`INSERT INTO api_keys (user_id, name, key_id, key_hash, last4, revoked_at) VALUES
    ($1, 'old', 'aaaaaaaaaaaaaaa1', '\\x02', 'wxyz', now() - interval '31 days'),
    ($1, 'recent', 'aaaaaaaaaaaaaaa2', '\\x02', 'wxyz', now() - interval '29 days'),
    ($1, 'live', 'aaaaaaaaaaaaaaa3', '\\x02', 'wxyz', NULL)`, [c.id]);
  assert.deepEqual(await sweepOnce(), { scans: 0, sessions: 0, keys: 1, ipUsage: 1 });
  assert.deepEqual((await query<{ name: string }>('SELECT name FROM api_keys ORDER BY name')).map((r) => r.name), ['live', 'recent']);
  assert.deepEqual((await query<{ subject: string }>("SELECT subject FROM usage WHERE subject IN ('ip:two', 'ip:one')")).map((r) => r.subject), ['ip:one']);
  console.log('ok  sweep: expired scans and sessions, IP rows older than yesterday, keys revoked over 30 days ago');

  // ---- A14: review JSON ----
  const deep = (n: number) => Array.from({ length: n }).reduce<unknown>((acc) => ({ a: acc }), 'x');
  assert.equal(reviewProblem({ ok: ['fine', { nested: 1 }], 'क': 'नमस्ते 😀' }), null);
  assert.equal(reviewProblem(deep(18)), null, 'shallow enough');
  assert.match(reviewProblem(deep(25))!, /deeper than 20/);
  assert.match(reviewProblem({ a: 'x\u0000y' })!, /NUL/);
  assert.match(reviewProblem({ ['k\u0000']: 1 })!, /NUL/, 'keys too');
  assert.match(reviewProblem(['\ud800'])!, /surrogate/);
  assert.match(reviewProblem({ a: 'x\udc00' })!, /surrogate/);
  console.log('ok  review JSON: NUL, lone surrogates and deep nesting rejected');
} finally {
  await closeDb();
}
