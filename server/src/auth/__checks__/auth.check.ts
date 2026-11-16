// Run: DATABASE_URL=postgres://vulnera:vulnera-dev@127.0.0.1:5432/vulnera_test npx tsx server/src/auth/__checks__/auth.check.ts
// GitHub sign-in end to end against a fake GitHub, sessions, logout, /api/me, account deletion, returnTo, rate limit.
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { closeDb, dbEnabled, query } from '../../db/pool.js';
import { makeUser, resetDb } from '../../db/testdb.js';
import { authRouter, resetAuthLimiter, safeReturnTo } from '../routes.js';
import { parseCookies, sha256 } from '../session.js';

if (!dbEnabled()) {
  console.log('SKIP auth checks: DATABASE_URL is not set');
  process.exit(0);
}
if (!/_test$/.test(new URL(process.env.DATABASE_URL!).pathname)) {
  console.log('auth checks only run against a *_test database');
  process.exit(1);
}

const listen = (app: express.Express) =>
  new Promise<{ server: Server; base: string }>((ok) => {
    const server = app.listen(0, '127.0.0.1', () => ok({ server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }));
  });

// ---- fake GitHub ----------------------------------------------------------------------------------------------
const gh = {
  token: `gho_${randomBytes(18).toString('hex')}`,
  user: { id: 4242, login: 'octo-cat', name: 'Octo Cat' } as Record<string, unknown>,
  emails: [] as unknown[],
  challenges: new Map<string, string>(), // code -> code_challenge
  exchanges: 0,
};
const resetGh = () => {
  gh.user = { id: 4242, login: 'octo-cat', name: 'Octo Cat' };
  gh.emails = [
    { email: 'old@example.com', primary: false, verified: true },
    { email: 'octo@example.com', primary: true, verified: true },
  ];
  gh.challenges.clear();
  gh.exchanges = 0;
};
const ghApp = express();
ghApp.post('/login/oauth/access_token', express.urlencoded({ extended: false }), (req, res) => {
  gh.exchanges++;
  const b = req.body as Record<string, string>;
  const challenge = gh.challenges.get(b.code);
  const pkceOk = challenge && createHash('sha256').update(b.code_verifier ?? '').digest('base64url') === challenge;
  if (req.get('accept') !== 'application/json') return void res.status(406).end();
  if (b.client_id !== 'cid' || b.client_secret !== 'csecret' || b.redirect_uri !== `${process.env.PUBLIC_ORIGIN}/auth/github/callback` || !pkceOk) {
    return void res.json({ error: 'bad_verification_code' });
  }
  gh.challenges.delete(b.code);
  res.json({ access_token: gh.token, token_type: 'bearer', scope: 'read:user,user:email' });
});
const ghAuth: express.RequestHandler = (req, res, next) => (req.get('authorization') === `Bearer ${gh.token}` ? next() : void res.status(401).json({}));
ghApp.get('/user', ghAuth, (_req, res) => res.json(gh.user));
ghApp.get('/user/emails', ghAuth, (_req, res) => res.json(gh.emails));
const fake = await listen(ghApp);

// ---- app under test ---------------------------------------------------------------------------------------------
Object.assign(process.env, {
  GITHUB_CLIENT_ID: 'cid',
  GITHUB_CLIENT_SECRET: 'csecret',
  PUBLIC_ORIGIN: 'http://localhost:5173',
  GITHUB_OAUTH_URL: fake.base,
  GITHUB_API_URL: fake.base,
  AUTH_FAIL_PER_MIN: '10000',
});
const ORIGIN = 'http://localhost:5173';
const stubPlan = async (userId: string | null, ip: string) => ({ plan: { id: userId ? 'free' : 'anonymous' }, usage: { ip: Boolean(ip) } });
const app = express();
app.use(authRouter({ planAndUsage: stubPlan }));
const realApp = express();
realApp.use(authRouter()); // the real quota.ts planAndUsage
const { server, base } = await listen(app);
const real = await listen(realApp);

const setCookies = (r: Response) => r.headers.getSetCookie();
const cookieValue = (r: Response, name: string) => {
  const line = setCookies(r).find((c) => c.startsWith(`${name}=`));
  return line === undefined ? undefined : line.slice(name.length + 1).split(';')[0];
};
const get = (path: string, cookie?: string, b = base) => fetch(`${b}${path}`, { redirect: 'manual', headers: cookie ? { cookie } : {} });

async function startLogin(returnTo?: string) {
  const r = await get(`/auth/github${returnTo === undefined ? '' : `?returnTo=${encodeURIComponent(returnTo)}`}`);
  assert.equal(r.status, 302);
  const loc = new URL(r.headers.get('location')!);
  const oauth = cookieValue(r, 'vulnera_oauth')!;
  assert.ok(oauth, 'oauth cookie set');
  const code = `code_${randomBytes(8).toString('hex')}`;
  gh.challenges.set(code, loc.searchParams.get('code_challenge')!);
  return { r, loc, oauth, code, state: loc.searchParams.get('state')! };
}
const callback = (qs: string, cookie?: string) => get(`/auth/github/callback?${qs}`, cookie);

async function login(returnTo?: string, extraCookie = '') {
  const s = await startLogin(returnTo);
  const r = await callback(`code=${s.code}&state=${s.state}`, `vulnera_oauth=${s.oauth}${extraCookie ? `; ${extraCookie}` : ''}`);
  return { ...s, cb: r, sid: cookieValue(r, 'vulnera_sid') };
}

async function allTablesText(): Promise<string> {
  const tables = ['plans', 'users', 'sessions', 'api_keys', 'scans', 'usage', 'ai_usage'];
  let out = '';
  for (const t of tables) {
    for (const row of await query<{ t: string }>(`SELECT (x.*)::text AS t FROM ${t} x`)) out += row.t + '\n';
    // bytea columns render as \x<hex>: also check hex forms of the token
  }
  return out;
}

const cases: [string, () => Promise<void>][] = [];
const test = (name: string, fn: () => Promise<void>) => cases.push([name, fn]);

test('authorize redirect: PKCE S256, state, scope, cookie flags', async () => {
  const { r, loc } = await startLogin('/history');
  assert.equal(`${loc.origin}${loc.pathname}`, `${fake.base}/login/oauth/authorize`);
  assert.equal(loc.searchParams.get('client_id'), 'cid');
  assert.equal(loc.searchParams.get('scope'), 'read:user user:email');
  assert.equal(loc.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(loc.searchParams.get('redirect_uri'), `${ORIGIN}/auth/github/callback`);
  assert.match(loc.searchParams.get('state')!, /^[A-Za-z0-9_-]{43}$/);
  const line = setCookies(r).find((c) => c.startsWith('vulnera_oauth='))!;
  assert.match(line, /; Path=\/auth/);
  assert.match(line, /; HttpOnly/);
  assert.match(line, /; SameSite=Lax/);
  assert.match(line, /; Max-Age=600/);
  assert.doesNotMatch(line, /Secure/, 'plain http origin: no Secure');
  assert.ok(!line.includes(loc.searchParams.get('code_challenge')!));
  assert.equal(r.headers.get('cache-control'), 'no-store');
});

test('happy path: user upserted, session row, cookie != stored hash, token stored nowhere', async () => {
  const { cb, sid, code } = await login('/history?x=1');
  assert.equal(cb.status, 302);
  assert.equal(cb.headers.get('location'), '/history?x=1');
  assert.ok(sid && /^[A-Za-z0-9_-]{43}$/.test(sid));
  const line = setCookies(cb).find((c) => c.startsWith('vulnera_sid='))!;
  assert.match(line, /Path=\/; HttpOnly; SameSite=Lax; Max-Age=2592000/);
  assert.match(cookieValue(cb, 'vulnera_oauth') ?? 'missing', /^$/, 'oauth cookie cleared');
  const users = await query<{ id: string; github_id: string; github_login: string; name: string; email: string }>('SELECT * FROM users');
  assert.equal(users.length, 1);
  assert.deepEqual([users[0]!.github_id, users[0]!.github_login, users[0]!.name, users[0]!.email], ['4242', 'octo-cat', 'Octo Cat', 'octo@example.com']);
  const sess = await query<{ id_hash: Buffer; user_id: string; expires_at: Date }>('SELECT * FROM sessions');
  assert.equal(sess.length, 1);
  assert.equal(sess[0]!.user_id, users[0]!.id);
  assert.ok(sess[0]!.id_hash.equals(sha256(sid!)));
  assert.notEqual(sess[0]!.id_hash.toString('base64url'), sid);
  assert.ok(Math.abs(new Date(sess[0]!.expires_at).getTime() - Date.now() - 30 * 86_400_000) < 60_000);
  const dump = await allTablesText();
  for (const secret of [gh.token, Buffer.from(gh.token).toString('hex'), sid!, Buffer.from(sid!).toString('hex'), code]) {
    assert.ok(!dump.includes(secret), 'secret found in the database');
  }
  const me = await (await get('/api/me', `vulnera_sid=${sid}`)).json();
  assert.equal(me.accounts, true);
  assert.equal(me.user.login, 'octo-cat');
  assert.equal(me.user.email, 'octo@example.com');
  assert.deepEqual(me.plan, { id: 'free' });
});

test('repeat login updates the user, replaces the old session row', async () => {
  const first = await login();
  gh.user = { id: 4242, login: 'octo-renamed', name: null };
  const second = await login(undefined, `vulnera_sid=${first.sid}`);
  assert.equal(second.cb.headers.get('location'), '/overview');
  assert.notEqual(second.sid, first.sid);
  const sess = await query<{ id_hash: Buffer }>('SELECT id_hash FROM sessions');
  assert.equal(sess.length, 1, 'old row deleted');
  assert.ok(sess[0]!.id_hash.equals(sha256(second.sid!)));
  const users = await query<{ github_login: string; name: string | null }>('SELECT github_login, name FROM users');
  assert.deepEqual(users, [{ github_login: 'octo-renamed', name: null }]);
  assert.equal((await (await get('/api/me', `vulnera_sid=${first.sid}`)).json()).user, null, 'old cookie no longer works');
});

test('state missing / mismatched / no cookie / tampered cookie → auth=state', async () => {
  const s = await startLogin();
  const ck = `vulnera_oauth=${s.oauth}`;
  const tampered = `vulnera_oauth=${s.oauth.replace(/^./, (c) => (c === 'A' ? 'B' : 'A'))}`;
  for (const [qs, cookie] of [
    [`code=${s.code}`, ck],
    [`code=${s.code}&state=`, ck],
    [`code=${s.code}&state=${s.state.slice(0, -1)}x`, ck],
    [`code=${s.code}&state=${s.state}&state=${s.state}`, ck],
    [`code=${s.code}&state=${s.state}`, undefined],
    [`code=${s.code}&state=${s.state}`, tampered],
    [`state=${s.state}`, ck],
  ] as const) {
    const r = await callback(qs, cookie);
    assert.equal(r.headers.get('location'), '/scan?auth=state', `${qs} ${cookie ? 'cookie' : 'no cookie'}`);
    assert.match(setCookies(r).find((c) => c.startsWith('vulnera_oauth='))!, /^vulnera_oauth=; Path=\/auth; .*Max-Age=0/);
    assert.equal(cookieValue(r, 'vulnera_sid'), undefined);
  }
  assert.equal(gh.exchanges, 0, 'no code exchange without a matching state');
  assert.equal((await query('SELECT 1 FROM users')).length, 0);
});

test('GitHub error=access_denied → auth=denied', async () => {
  const s = await startLogin();
  const r = await callback(`error=access_denied&error_description=x&state=${s.state}`, `vulnera_oauth=${s.oauth}`);
  assert.equal(r.headers.get('location'), '/scan?auth=denied');
});

test('no primary verified email → auth=email', async () => {
  gh.emails = [
    { email: 'a@example.com', primary: true, verified: false },
    { email: 'b@example.com', primary: false, verified: true },
  ];
  const { cb, sid } = await login();
  assert.equal(cb.headers.get('location'), '/scan?auth=email');
  assert.equal(sid, undefined);
  assert.equal((await query('SELECT 1 FROM users')).length, 0);
});

test('bad code (exchange fails) → auth=error', async () => {
  const s = await startLogin();
  const r = await callback(`code=wrong&state=${s.state}`, `vulnera_oauth=${s.oauth}`);
  assert.equal(r.headers.get('location'), '/scan?auth=error');
});

test('returnTo: only same-site paths', async () => {
  for (const bad of ['//evil.com', '/\\evil.com', 'https://evil.com', '/\t/evil.com', ' /ok', 'evil.com', `/${'a'.repeat(200)}`, 'javascript:alert(1)']) {
    assert.equal(safeReturnTo(bad), null, JSON.stringify(bad));
  }
  assert.equal(safeReturnTo('/ok'), '/ok');
  assert.equal(safeReturnTo('/scans/abc?tab=1#x'), '/scans/abc?tab=1#x');
  for (const bad of ['//evil.com', '/\\evil.com', 'https://evil.com']) {
    const { cb } = await login(bad);
    assert.equal(cb.headers.get('location'), '/overview', bad);
  }
  assert.equal((await login('/ok')).cb.headers.get('location'), '/ok');
});

test('logout deletes the row and clears the cookie; CSRF-guarded', async () => {
  const { sid } = await login();
  const cross = await fetch(`${base}/api/auth/logout`, { method: 'POST', headers: { cookie: `vulnera_sid=${sid}`, origin: 'https://evil.example' } });
  assert.equal(cross.status, 403);
  assert.equal((await query('SELECT 1 FROM sessions')).length, 1);
  const r = await fetch(`${base}/api/auth/logout`, { method: 'POST', headers: { cookie: `vulnera_sid=${sid}`, origin: ORIGIN, 'content-type': 'application/json' }, body: '{}' });
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true });
  assert.equal(r.headers.get('cache-control'), 'no-store');
  assert.match(setCookies(r).find((c) => c.startsWith('vulnera_sid='))!, /^vulnera_sid=; .*Max-Age=0/);
  assert.equal((await query('SELECT 1 FROM sessions')).length, 0);
  // already-deleted, unknown, malformed or missing cookie: still 200 and cleared
  for (const ck of [`vulnera_sid=${sid}`, `vulnera_sid=${randomBytes(32).toString('base64url')}`, 'vulnera_sid=junk', '']) {
    const again = await fetch(`${base}/api/auth/logout`, { method: 'POST', headers: { ...(ck ? { cookie: ck } : {}), origin: ORIGIN } });
    assert.equal(again.status, 200, ck);
    assert.deepEqual(await again.json(), { ok: true });
    assert.match(setCookies(again).find((c) => c.startsWith('vulnera_sid='))!, /^vulnera_sid=; .*Max-Age=0/);
  }
});

test('logout-all deletes every session of the user (and only theirs); CSRF-guarded; needs a session', async () => {
  const u = await makeUser();
  const other = await makeUser();
  const mk = async (uid: string) => {
    const tok = randomBytes(32).toString('base64url');
    await query(`INSERT INTO sessions (id_hash, user_id, expires_at) VALUES ($1, $2, now() + interval '1 day')`, [sha256(tok), uid]);
    return `vulnera_sid=${tok}`;
  };
  const [a, b, o] = [await mk(u.id), await mk(u.id), await mk(other.id)];
  const post = (cookie: string | undefined, origin = ORIGIN, extra: Record<string, string> = {}) =>
    fetch(`${base}/api/auth/logout-all`, { method: 'POST', headers: { ...(cookie ? { cookie } : {}), origin, 'content-type': 'application/json', ...extra }, body: '{}' });
  assert.equal((await post(undefined)).status, 401, 'no session');
  assert.equal((await post(a, 'https://evil.example')).status, 403, 'cross-site');
  assert.equal((await post(a, ORIGIN, { authorization: 'Bearer vk_junk' })).status, 401, 'a Bearer request never uses the cookie');
  assert.equal((await query('SELECT 1 FROM sessions WHERE user_id = $1', [u.id])).length, 2);
  const r = await post(a);
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true });
  assert.equal(r.headers.get('cache-control'), 'no-store');
  assert.match(setCookies(r).find((c) => c.startsWith('vulnera_sid='))!, /^vulnera_sid=; .*Max-Age=0/);
  assert.equal((await query('SELECT 1 FROM sessions WHERE user_id = $1', [u.id])).length, 0, 'both sessions of the user are gone');
  assert.equal((await query('SELECT 1 FROM sessions WHERE user_id = $1', [other.id])).length, 1, 'another user keeps theirs');
  assert.equal((await (await get('/api/me', b)).json()).user, null, 'the other device is signed out');
  assert.equal((await (await get('/api/me', o)).json()).user.id, other.id);
});

test('logout with a Bearer header does not touch the cookie session', async () => {
  const { sid } = await login();
  const r = await fetch(`${base}/api/auth/logout`, { method: 'POST', headers: { cookie: `vulnera_sid=${sid}`, authorization: 'Bearer vk_junk', origin: 'https://evil.example' } });
  assert.equal(r.status, 200);
  assert.equal((await query('SELECT 1 FROM sessions')).length, 1, 'the session survives: a Bearer request skips the CSRF check, so it may not act on the cookie');
});

test('expired session is rejected; last_seen_at refreshed only when stale', async () => {
  const u = await makeUser();
  const tok = randomBytes(32).toString('base64url');
  await query(`INSERT INTO sessions (id_hash, user_id, expires_at) VALUES ($1, $2, now() - interval '1 second')`, [sha256(tok), u.id]);
  assert.equal((await (await get('/api/me', `vulnera_sid=${tok}`)).json()).user, null);
  const out = await fetch(`${base}/api/auth/logout`, { method: 'POST', headers: { cookie: `vulnera_sid=${tok}`, origin: ORIGIN } });
  assert.equal(out.status, 200, 'expired session: logout still succeeds');
  assert.match(setCookies(out).find((c) => c.startsWith('vulnera_sid='))!, /Max-Age=0/);
  const xs = await fetch(`${base}/api/auth/logout`, { method: 'POST', headers: { cookie: `vulnera_sid=${tok}`, origin: 'https://evil.example' } });
  assert.equal(xs.status, 403, 'sameOrigin still in front of logout');
  // live session, last seen an hour ago: bumped
  const tok2 = randomBytes(32).toString('base64url');
  await query(`INSERT INTO sessions (id_hash, user_id, expires_at, last_seen_at) VALUES ($1, $2, now() + interval '1 day', now() - interval '1 hour')`, [sha256(tok2), u.id]);
  assert.equal((await (await get('/api/me', `vulnera_sid=${tok2}`)).json()).user.id, u.id);
  await new Promise((r) => setTimeout(r, 100));
  const [row] = await query<{ age: number }>(`SELECT extract(epoch FROM now() - last_seen_at)::float AS age FROM sessions WHERE id_hash = $1`, [sha256(tok2)]);
  assert.ok(row!.age < 60, 'last_seen_at updated');
  // a Bearer header means the cookie is never consulted (the CSRF check is skipped for such requests)
  const bearer = await fetch(`${base}/api/me`, { headers: { cookie: `vulnera_sid=${tok2}`, authorization: 'Bearer vk_junk' } });
  assert.equal((await bearer.json()).user, null, 'Bearer wins over the cookie');
  const forged = await fetch(`${base}/api/me`, { method: 'DELETE', headers: { cookie: `vulnera_sid=${tok2}`, authorization: 'Bearer x', origin: 'https://evil.example', 'content-type': 'application/json' }, body: JSON.stringify({ confirm: u.github_login }) });
  assert.equal(forged.status, 401, 'CSRF skipped for Bearer, but the cookie does not authenticate');
  assert.equal((await query('SELECT 1 FROM users WHERE id = $1', [u.id])).length, 1);
  // malformed cookies never reach the database as a match
  for (const c of ['vulnera_sid=', 'vulnera_sid=abc', `vulnera_sid=${tok2}x`, `__proto__=x; vulnera_sid=%zz`]) {
    assert.equal((await (await get('/api/me', c)).json()).user, null, c);
  }
});

test('/api/me signed out, and with the real quota.ts', async () => {
  const r = await get('/api/me');
  assert.equal(r.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await r.json(), { accounts: true, user: null, plan: { id: 'anonymous' }, usage: { ip: true } });
  const anon = await (await get('/api/me', undefined, real.base)).json();
  assert.equal(anon.accounts, true);
  assert.equal(anon.plan.id, 'anonymous');
  const { sid } = await login();
  const me = await (await get('/api/me', `vulnera_sid=${sid}`, real.base)).json();
  assert.equal(me.user.login, 'octo-cat');
  assert.equal(me.plan.id, 'free');
});

test('DELETE /api/me: wrong confirm 400, right confirm removes everything', async () => {
  const { sid } = await login();
  const [{ id }] = (await query<{ id: string }>('SELECT id FROM users')) as [{ id: string }];
  await query(`INSERT INTO api_keys (user_id, name, key_id, key_hash, last4) VALUES ($1, 'ci', 'abcd', '\\x02', 'wxyz')`, [id]);
  await query(
    `INSERT INTO scans (user_id, source, project_name, package_count, finding_count, fix_now_count, ai_status, result, result_bytes)
     VALUES ($1, 'upload', 'p', 1, 0, 0, 'disabled', '{}', 2)`,
    [id],
  );
  await query(`INSERT INTO usage (subject, period, user_id, scans) VALUES ($1, current_date, $2, 1)`, [`user:${id}`, id]);
  const other = await makeUser();
  const del = (confirm: unknown, headers: Record<string, string> = {}) =>
    fetch(`${base}/api/me`, {
      method: 'DELETE',
      headers: { cookie: `vulnera_sid=${sid}`, origin: ORIGIN, 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ confirm }),
    });
  for (const bad of ['Octo-Cat', 'octo-cat ', '', 42, null]) {
    const r = await del(bad);
    assert.equal(r.status, 400, String(bad));
  }
  assert.equal((await del('octo-cat', { origin: 'https://evil.example' })).status, 403);
  assert.equal((await query('SELECT 1 FROM users WHERE id = $1', [id])).length, 1);
  const ok = await del('octo-cat');
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { ok: true });
  assert.match(setCookies(ok).find((c) => c.startsWith('vulnera_sid='))!, /Max-Age=0/);
  for (const t of ['users WHERE id = $1', 'sessions WHERE user_id = $1', 'api_keys WHERE user_id = $1', 'scans WHERE user_id = $1', 'usage WHERE user_id = $1']) {
    assert.equal((await query(`SELECT 1 FROM ${t}`, [id])).length, 0, t);
  }
  assert.equal((await query('SELECT 1 FROM users WHERE id = $1', [other.id])).length, 1, 'other users untouched');
  assert.equal((await del('octo-cat')).status, 401);
});

test('https origin: __Host- cookie with Secure', async () => {
  process.env.PUBLIC_ORIGIN = 'https://vulnera.example';
  try {
    const r = await get('/auth/github');
    const oline = setCookies(r).find((c) => c.startsWith('__Host-vulnera_oauth='))!;
    assert.match(oline, /^__Host-vulnera_oauth=[A-Za-z0-9_.-]+; Path=\/; HttpOnly; SameSite=Lax; Max-Age=600; Secure$/);
    assert.equal(cookieValue(r, 'vulnera_oauth'), undefined);
    const loc = new URL(r.headers.get('location')!);
    const blob = cookieValue(r, '__Host-vulnera_oauth')!;
    const s = { state: loc.searchParams.get('state')!, code: 'code_https' };
    gh.challenges.set(s.code, loc.searchParams.get('code_challenge')!);
    // the plain name (what a sibling subdomain could set) is ignored on https, and the __Host- cookie is still cleared
    const tossed = await callback(`code=${s.code}&state=${s.state}`, `vulnera_oauth=${blob}`);
    assert.equal(tossed.headers.get('location'), '/scan?auth=state');
    assert.match(setCookies(tossed).find((c) => c.startsWith('__Host-vulnera_oauth='))!, /^__Host-vulnera_oauth=; Path=\/; .*Max-Age=0; Secure$/);
    const cb = await callback(`code=${s.code}&state=${s.state}`, `__Host-vulnera_oauth=${blob}`);
    assert.match(setCookies(cb).find((c) => c.startsWith('__Host-vulnera_oauth='))!, /Max-Age=0/);
    const line = setCookies(cb).find((c) => c.startsWith('__Host-vulnera_sid='))!;
    assert.match(line, /^__Host-vulnera_sid=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; SameSite=Lax; Max-Age=\d+; Secure$/);
    assert.equal(cookieValue(cb, 'vulnera_sid'), undefined);
    const sid = cookieValue(cb, '__Host-vulnera_sid')!;
    assert.equal((await (await get('/api/me', `vulnera_sid=${sid}`)).json()).user, null, 'plain name ignored on https');
    assert.equal((await (await get('/api/me', `__Host-vulnera_sid=${sid}`)).json()).user.login, 'octo-cat');
  } finally {
    process.env.PUBLIC_ORIGIN = ORIGIN;
  }
});

test('accounts off: /auth routes 404, /api/me says accounts:false', async () => {
  delete process.env.GITHUB_CLIENT_ID;
  try {
    assert.equal((await get('/auth/github')).status, 404);
    assert.equal((await get('/auth/github/callback?code=x&state=y')).status, 404);
    assert.deepEqual(await (await get('/api/me')).json(), { accounts: false });
    assert.equal((await fetch(`${base}/api/auth/logout`, { method: 'POST' })).status, 404);
  } finally {
    process.env.GITHUB_CLIENT_ID = 'cid';
  }
});

test('production ignores GITHUB_OAUTH_URL / GITHUB_API_URL', async () => {
  const { oauthBase, apiBase } = await import('../github.js');
  assert.equal(oauthBase(), fake.base);
  const env = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try {
    assert.equal(oauthBase(), 'https://github.com');
    assert.equal(apiBase(), 'https://api.github.com');
  } finally {
    process.env.NODE_ENV = env;
  }
});

test('sign-in attempts are rate limited per IP', async () => {
  process.env.AUTH_FAIL_PER_MIN = '5';
  try {
    const codes: number[] = [];
    for (let i = 0; i < 6; i++) codes.push((await get('/auth/github/callback?state=x')).status);
    assert.equal(codes.at(-1), 429);
    const limited = await get('/auth/github/callback?state=x');
    assert.match(setCookies(limited).find((c) => c.startsWith('vulnera_oauth='))!, /Max-Age=0/, 'cleared even when rate limited');
    assert.equal((await get('/auth/github')).status, 429);
  } finally {
    process.env.AUTH_FAIL_PER_MIN = '10000';
  }
});

test('cookie parser', async () => {
  const c = parseCookies('a=1; b="2"; a=3; __proto__=x; c=%41; bad; d=%zz');
  assert.equal(c.a, '1');
  assert.equal(c.b, '2');
  assert.equal(c.c, 'A');
  assert.equal(c.d, '%zz');
  assert.equal(Object.getPrototypeOf(c), null);
  assert.equal(({} as Record<string, unknown>).x, undefined);
});

let failed = 0;
try {
  for (const [name, fn] of cases) {
    await resetDb();
    resetGh();
    resetAuthLimiter();
    try {
      await fn();
      console.log(`ok  ${name}`);
    } catch (e) {
      failed++;
      console.log(`FAIL ${name}`);
      console.log(e);
    }
  }
} finally {
  server.close();
  real.server.close();
  fake.server.close();
  await closeDb();
}
if (failed) {
  console.log(`${failed} AUTH CHECK(S) FAILED`);
  process.exit(1);
}
console.log('ALL AUTH CHECKS PASSED');
