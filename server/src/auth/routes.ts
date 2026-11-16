import { createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';
import express, { type Request, type RequestHandler, type Response, Router } from 'express';
import { query } from '../db/pool.js';
import { planAndUsage as realPlanAndUsage } from '../quota.js';
import { accountsEnabled, secureCookies } from './config.js';
import { sameOrigin } from './csrf.js';
import { authorizeUrl, exchangeCode, fetchProfile, GitHubAuthError, randomToken } from './github.js';
import { clearSessionCookie, createSession, destroySession, parseCookies, requireSession, serializeCookie, sessionToken, sessionUser, sha256, type SessionUser } from './session.js';

// Routes: GET /auth/github, GET /auth/github/callback, POST /api/auth/logout, GET /api/me, DELETE /api/me.

export type PlanAndUsage = (userId: string | null, ip: string) => Promise<{ plan: unknown; usage: unknown }>;
export interface AuthRouterDeps {
  /** Test seam; defaults to `planAndUsage` from ../quota.ts. */
  planAndUsage?: PlanAndUsage;
}

// On https: __Host- (Secure, Path=/, no Domain), so a sibling subdomain cannot plant its own signed blob and
// state and sign the victim in to the attacker's account (login CSRF by cookie tossing). Plain http (local): Path=/auth.
const oauthCookieName = () => (secureCookies() ? '__Host-vulnera_oauth' : 'vulnera_oauth');
const OAUTH_TTL_S = 600;
const DEFAULT_RETURN = '/overview';
const noStore = (res: Response) => res.setHeader('Cache-Control', 'no-store');
const smallJson = express.json({ limit: '4kb' });

// ---- returnTo: same-site paths only ------------------------------------------------------------------------

/** A path on this site: one leading '/', not '//', no backslash, no whitespace or control characters, ≤ 200 chars. */
export function safeReturnTo(v: unknown): string | null {
  if (typeof v !== 'string' || v.length === 0 || v.length > 200) return null;
  if (!v.startsWith('/') || v.startsWith('//')) return null;
  // Only URL-safe printable ASCII: rules out '\', spaces, tabs and newlines (which browsers strip, turning '/\t/x' into '//x').
  if (!/^\/[A-Za-z0-9\-._~!$&'()*+,;=:@%/?#]*$/.test(v)) return null;
  try {
    const base = 'http://vulnera.invalid';
    if (new URL(v, base).origin !== base) return null; // belt and braces: whatever a URL parser makes of it stays here
  } catch {
    return null;
  }
  return v;
}

// ---- the short-lived OAuth cookie: HMAC-signed {state, verifier, returnTo, expiry} --------------------------

interface OAuthBlob {
  s: string;
  v: string;
  r: string;
  e: number;
}

const signingKey = (): Buffer =>
  Buffer.from(hkdfSync('sha256', process.env.GITHUB_CLIENT_SECRET?.trim() ?? '', 'vulnera', 'oauth-cookie-v1', 32));
const mac = (payload: string) => createHmac('sha256', signingKey()).update(payload).digest();

function sealOAuth(b: OAuthBlob): string {
  const payload = Buffer.from(JSON.stringify(b)).toString('base64url');
  return `${payload}.${mac(payload).toString('base64url')}`;
}

function openOAuth(raw: string | undefined): OAuthBlob | null {
  if (!raw || raw.length > 2048) return null;
  const [payload, sig, extra] = raw.split('.');
  if (!payload || !sig || extra !== undefined) return null;
  const got = Buffer.from(sig, 'base64url');
  const want = mac(payload);
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
  try {
    const b = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as OAuthBlob;
    if (typeof b.s !== 'string' || typeof b.v !== 'string' || typeof b.r !== 'string' || typeof b.e !== 'number') return null;
    if (Date.now() > b.e) return null;
    return b;
  } catch {
    return null;
  }
}

const setOAuthCookie = (res: Response, value: string, maxAge: number) => {
  const secure = secureCookies();
  res.append('Set-Cookie', serializeCookie(oauthCookieName(), value, { maxAge, path: secure ? '/' : '/auth', secure }));
};

function sameSecret(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
}

// ---- per-IP limit on sign-in attempts (starts, callback hits, failures) ---------------------------------------

const hits = new Map<string, { n: number; reset: number }>();
const authLimit = () => {
  const n = Math.floor(Number(process.env.AUTH_FAIL_PER_MIN));
  return Number.isFinite(n) && n >= 1 ? n : 20;
};

/** Count one attempt; true when the IP is over the per-minute limit. */
function overLimit(ip: string, weight = 1): boolean {
  const now = Date.now();
  if (hits.size > 50_000) for (const [k, v] of hits) if (v.reset <= now) hits.delete(k);
  if (hits.size > 50_000) hits.clear(); // memory bound under a flood of spoofed-looking addresses
  let h = hits.get(ip);
  if (!h || h.reset <= now) hits.set(ip, (h = { n: 0, reset: now + 60_000 }));
  h.n += weight;
  return h.n > authLimit();
}
/** For tests. */
export const resetAuthLimiter = () => hits.clear();

const clientIp = (req: Request) => req.ip || req.socket.remoteAddress || 'unknown';

const tooMany = (res: Response) => {
  noStore(res);
  res.setHeader('Retry-After', '60');
  res.status(429).json({ error: 'Too many sign-in attempts. Try again in a minute.' });
};

const accountsOnly: RequestHandler = (_req, res, next) => {
  if (!accountsEnabled()) return void res.status(404).json({ error: 'Not found.' });
  next();
};

const publicUser = (u: SessionUser) => ({ id: u.id, login: u.login, name: u.name, email: u.email, createdAt: u.createdAt });

// ---- router -----------------------------------------------------------------------------------------------

export function authRouter(deps: AuthRouterDeps = {}): Router {
  const planAndUsage: PlanAndUsage = deps.planAndUsage ?? realPlanAndUsage;
  const r = Router();

  r.get('/auth/github', accountsOnly, (req, res) => {
    noStore(res);
    if (overLimit(clientIp(req))) return tooMany(res);
    const state = randomToken(32);
    const verifier = randomToken(32); // 43 chars: within PKCE's 43..128
    const returnTo = safeReturnTo(req.query.returnTo) ?? DEFAULT_RETURN;
    setOAuthCookie(res, sealOAuth({ s: state, v: verifier, r: returnTo, e: Date.now() + OAUTH_TTL_S * 1000 }), OAUTH_TTL_S);
    res.redirect(302, authorizeUrl(state, verifier));
  });

  r.get('/auth/github/callback', accountsOnly, async (req, res) => {
    noStore(res);
    res.setHeader('Referrer-Policy', 'no-referrer'); // the URL carries the code
    setOAuthCookie(res, '', 0); // single use: cleared on every outcome, the rate-limit refusal included
    const ip = clientIp(req);
    if (overLimit(ip)) return tooMany(res);
    // Only the name for the current mode: on https a plain `vulnera_oauth` (settable by a sibling) is ignored.
    const blob = openOAuth(parseCookies(req.headers.cookie)[oauthCookieName()]);
    const fail = (why: 'denied' | 'state' | 'email' | 'error') => {
      overLimit(ip); // failures count double
      res.redirect(302, `/scan?auth=${why}`);
    };

    if (req.query.error !== undefined) return fail('denied');
    const { code, state } = req.query;
    if (typeof code !== 'string' || typeof state !== 'string' || !code || code.length > 512 || !blob || !sameSecret(state, blob.s)) return fail('state');

    let profile;
    try {
      profile = await fetchProfile(await exchangeCode(code, blob.v));
    } catch (e) {
      const kind = e instanceof GitHubAuthError ? e.kind : 'error';
      console.warn(`[auth] GitHub sign-in failed: ${e instanceof GitHubAuthError ? e.message : 'unexpected error'}`);
      return fail(kind);
    }

    try {
      const rows = await query<{ id: string }>(
        `INSERT INTO users (github_id, github_login, name, email) VALUES ($1, $2, $3, $4)
         ON CONFLICT (github_id) DO UPDATE
           SET github_login = EXCLUDED.github_login, name = EXCLUDED.name, email = EXCLUDED.email, last_login_at = now()
         RETURNING id`,
        [profile.githubId, profile.login, profile.name, profile.email],
      );
      const old = sessionToken(req);
      if (old) await query('DELETE FROM sessions WHERE id_hash = $1', [sha256(old)]); // rotate: the old id dies
      await createSession(res, rows[0]!.id);
    } catch (e) {
      console.error(`[auth] saving the sign-in failed: ${(e as Error).message}`);
      return fail('error');
    }
    res.redirect(302, safeReturnTo(blob.r) ?? DEFAULT_RETURN);
  });

  // No requireSession: an expired or unknown cookie still gets cleared, so logging out always leaves the browser signed out.
  r.post('/api/auth/logout', accountsOnly, sameOrigin, smallJson, async (req, res) => {
    noStore(res);
    await destroySession(req, res);
    res.json({ ok: true });
  });

  r.get('/api/me', async (req, res) => {
    noStore(res);
    if (!accountsEnabled()) return void res.json({ accounts: false });
    const user = await sessionUser(req);
    const { plan, usage } = await planAndUsage(user?.id ?? null, clientIp(req));
    res.json({ accounts: true, user: user ? publicUser(user) : null, plan, usage });
  });

  r.delete('/api/me', accountsOnly, sameOrigin, requireSession, smallJson, async (req, res) => {
    noStore(res);
    const user = res.locals.user as SessionUser;
    const confirm = (req.body as { confirm?: unknown } | undefined)?.confirm;
    if (typeof confirm !== 'string' || confirm !== user.login) {
      return void res.status(400).json({ error: 'Type your GitHub login exactly to confirm.', code: 'confirm_mismatch' });
    }
    await query('DELETE FROM users WHERE id = $1', [user.id]); // cascades: sessions, api_keys, scans, usage
    clearSessionCookie(res);
    res.json({ ok: true });
  });

  return r;
}
