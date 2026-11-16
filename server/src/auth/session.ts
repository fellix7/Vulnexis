import { createHash, randomBytes } from 'node:crypto';
import type { Request, RequestHandler, Response } from 'express';
import { query } from '../db/pool.js';
import { accountsEnabled, secureCookies } from './config.js';

// Browser sessions. The session id lives only in the cookie; the database keeps its sha256, so a leaked
// database (or log of one) cannot be replayed as a cookie. Every sign-in creates a new row; sign-out deletes it.
// Cookie values are never logged.

export interface SessionUser {
  id: string;
  login: string;
  name: string | null;
  email: string | null;
  planId: string;
  createdAt: string;
}

export const SESSION_COOKIE_SECURE = '__Host-vulnera_sid';
export const SESSION_COOKIE_PLAIN = 'vulnera_sid';
/** `__Host-` (Secure, Path=/, no Domain: a sibling subdomain cannot set or overwrite it) when served over https. */
export const sessionCookieName = (): string => (secureCookies() ? SESSION_COOKIE_SECURE : SESSION_COOKIE_PLAIN);

const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/; // 32 bytes, base64url, no padding
const LAST_SEEN_EVERY_MS = 10 * 60_000;

export const sha256 = (s: string): Buffer => createHash('sha256').update(s, 'utf8').digest();

/**
 * Parse a Cookie header. The first occurrence of a name wins (browsers send the most specific path first).
 * Returns a null-prototype object, so names like `__proto__` cannot pollute anything. Bounded work on huge headers.
 */
export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = Object.create(null);
  if (!header || typeof header !== 'string') return out;
  const parts = header.slice(0, 8192).split(';');
  for (const part of parts.slice(0, 100)) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const name = part.slice(0, eq).trim();
    if (!name || name in out) continue;
    let value = part.slice(eq + 1).trim();
    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) value = value.slice(1, -1);
    try {
      value = decodeURIComponent(value);
    } catch {
      /* keep the raw value; it will fail format checks */
    }
    out[name] = value;
  }
  return out;
}

export interface CookieOptions {
  maxAge: number; // seconds; 0 deletes
  path?: string;
  secure?: boolean;
}

/** Serialise a Set-Cookie value. Always HttpOnly and SameSite=Lax. Name and value must be cookie-safe already. */
export function serializeCookie(name: string, value: string, opts: CookieOptions): string {
  if (!/^[A-Za-z0-9_-]+$/.test(name) || !/^[A-Za-z0-9_.~-]*$/.test(value)) throw new Error('unsafe cookie name or value');
  const parts = [`${name}=${value}`, `Path=${opts.path ?? '/'}`, 'HttpOnly', 'SameSite=Lax', `Max-Age=${Math.max(0, Math.floor(opts.maxAge))}`];
  if (opts.secure) parts.push('Secure');
  return parts.join('; ');
}

/** The session token from the request's cookie, if it is well formed. */
export function sessionToken(req: Pick<Request, 'headers'>): string | null {
  const v = parseCookies(req.headers.cookie)[sessionCookieName()];
  return v && TOKEN_RE.test(v) ? v : null;
}

/** True if the request carries a session cookie under either name (used by the CSRF check). */
export function hasSessionCookie(req: Pick<Request, 'headers'>): boolean {
  const c = parseCookies(req.headers.cookie);
  return SESSION_COOKIE_SECURE in c || SESSION_COOKIE_PLAIN in c;
}

const ttlDays = (): number => {
  const n = Math.floor(Number(process.env.SESSION_TTL_DAYS));
  return Number.isFinite(n) && n >= 1 ? Math.min(n, 365) : 30;
};

// One lookup per request, however many middlewares ask.
const cache = new WeakMap<object, Promise<SessionUser | null>>();

async function lookup(token: string): Promise<SessionUser | null> {
  const hash = sha256(token);
  const rows = await query<{
    id: string;
    github_login: string;
    name: string | null;
    email: string | null;
    plan_id: string;
    created_at: Date;
    last_seen_at: Date;
  }>(
    `SELECT u.id, u.github_login, u.name, u.email, u.plan_id, u.created_at, s.last_seen_at
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.id_hash = $1 AND s.expires_at > now()`,
    [hash],
  );
  const r = rows[0];
  if (!r) return null;
  if (Date.now() - new Date(r.last_seen_at).getTime() > LAST_SEEN_EVERY_MS) {
    query(`UPDATE sessions SET last_seen_at = now() WHERE id_hash = $1 AND last_seen_at < now() - interval '10 minutes'`, [hash]).catch((e) =>
      console.error('[auth] last_seen update failed:', (e as Error).message),
    );
  }
  return { id: r.id, login: r.github_login, name: r.name, email: r.email, planId: r.plan_id, createdAt: new Date(r.created_at).toISOString() };
}

/**
 * Same test as caller.ts uses to pick the API-key path. The CSRF check is skipped for such requests, so the cookie
 * must never authenticate them: "Bearer wins over a cookie", everywhere, including session-only routes.
 */
export const hasBearer = (req: Pick<Request, 'headers'>): boolean => /^Bearer\s+(\S+)\s*$/i.test(String(req.headers.authorization ?? ''));

/** The signed-in user, or null (no cookie, bad cookie, expired or deleted session, a Bearer header, or accounts off). */
export function sessionUser(req: Request): Promise<SessionUser | null> {
  if (!accountsEnabled() || hasBearer(req)) return Promise.resolve(null);
  const hit = cache.get(req);
  if (hit) return hit;
  const token = sessionToken(req);
  const p = token ? lookup(token) : Promise.resolve(null);
  cache.set(req, p);
  return p;
}

/** 401 unless signed in; sets `res.locals.user`. */
export const requireSession: RequestHandler = async (req, res, next) => {
  const user = await sessionUser(req);
  if (!user) {
    res.setHeader('Cache-Control', 'no-store');
    return void res.status(401).json({ error: 'Sign in first.', code: 'signin_required' });
  }
  res.locals.user = user;
  next();
};

/** Create a new session row for `userId` and set the cookie. */
export async function createSession(res: Response, userId: string): Promise<void> {
  const token = randomBytes(32).toString('base64url');
  const days = ttlDays();
  await query(`INSERT INTO sessions (id_hash, user_id, expires_at) VALUES ($1, $2, now() + make_interval(days => $3))`, [sha256(token), userId, days]);
  res.append('Set-Cookie', serializeCookie(sessionCookieName(), token, { maxAge: days * 86_400, secure: secureCookies() }));
}

/** Expire the session cookie in the browser. */
export function clearSessionCookie(res: Response): void {
  res.append('Set-Cookie', serializeCookie(sessionCookieName(), '', { maxAge: 0, secure: secureCookies() }));
}

/** Delete the request's session row (if any) and clear the cookie. */
export async function destroySession(req: Request, res: Response): Promise<void> {
  const token = sessionToken(req);
  if (token) await query('DELETE FROM sessions WHERE id_hash = $1', [sha256(token)]);
  cache.delete(req);
  clearSessionCookie(res);
}
