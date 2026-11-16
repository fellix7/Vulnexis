import { createHash, randomBytes } from 'node:crypto';
import { isProduction } from '../env.js';
import { publicOrigin } from './config.js';

// GitHub OAuth (authorization code + PKCE S256 + state). The access token is used for two read calls
// (/user and /user/emails) and then dropped: it is never stored, logged or put in an error message.

export const SCOPE = 'read:user user:email';
const TIMEOUT_MS = 10_000;
const MAX_BODY = 1_000_000;

/** Why sign-in failed, in the words the callback redirects with. Messages never contain tokens or codes. */
export class GitHubAuthError extends Error {
  constructor(
    readonly kind: 'email' | 'error',
    message: string,
  ) {
    super(message);
  }
}

const trimSlash = (s: string) => s.replace(/\/+$/, '');
/** Overridable only outside production, so tests can point at a local fake; production always talks to GitHub. */
export const oauthBase = (): string => (!isProduction() && process.env.GITHUB_OAUTH_URL?.trim() ? trimSlash(process.env.GITHUB_OAUTH_URL.trim()) : 'https://github.com');
export const apiBase = (): string => (!isProduction() && process.env.GITHUB_API_URL?.trim() ? trimSlash(process.env.GITHUB_API_URL.trim()) : 'https://api.github.com');

export const redirectUri = (): string => `${publicOrigin()}/auth/github/callback`;

export const randomToken = (bytes = 32): string => randomBytes(bytes).toString('base64url');
export const pkceChallenge = (verifier: string): string => createHash('sha256').update(verifier, 'ascii').digest('base64url');

export function authorizeUrl(state: string, verifier: string): string {
  const q = new URLSearchParams({
    client_id: process.env.GITHUB_CLIENT_ID?.trim() ?? '',
    redirect_uri: redirectUri(),
    scope: SCOPE,
    state,
    code_challenge: pkceChallenge(verifier),
    code_challenge_method: 'S256',
    allow_signup: 'true',
  });
  return `${oauthBase()}/login/oauth/authorize?${q}`;
}

async function readJson(res: Response, what: string): Promise<unknown> {
  const len = Number(res.headers.get('content-length'));
  if (len > MAX_BODY) throw new GitHubAuthError('error', `${what}: response too large`);
  const text = await res.text();
  if (text.length > MAX_BODY) throw new GitHubAuthError('error', `${what}: response too large`);
  try {
    return JSON.parse(text);
  } catch {
    throw new GitHubAuthError('error', `${what}: not JSON (HTTP ${res.status})`);
  }
}

async function call(url: string, init: RequestInit, what: string): Promise<unknown> {
  let res: Response;
  try {
    // redirect: 'error' so the token is never replayed to wherever a redirect points.
    res = await fetch(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (e) {
    throw new GitHubAuthError('error', `${what}: ${(e as Error).name === 'TimeoutError' ? 'timed out' : 'request failed'}`);
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    throw new GitHubAuthError('error', `${what}: HTTP ${res.status}`);
  }
  return readJson(res, what);
}

/** Exchange the authorization code for an access token. */
export async function exchangeCode(code: string, verifier: string): Promise<string> {
  const body = new URLSearchParams({
    client_id: process.env.GITHUB_CLIENT_ID?.trim() ?? '',
    client_secret: process.env.GITHUB_CLIENT_SECRET?.trim() ?? '',
    code,
    code_verifier: verifier,
    redirect_uri: redirectUri(),
  });
  const data = (await call(
    `${oauthBase()}/login/oauth/access_token`,
    { method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'vulnera' }, body },
    'token exchange',
  )) as { access_token?: unknown; error?: unknown };
  // GitHub answers 200 with {error: 'bad_verification_code'} etc. Only the error code is kept, never the body.
  if (typeof data?.access_token !== 'string' || !data.access_token) {
    const err = typeof data?.error === 'string' && /^[a-z_]{1,64}$/.test(data.error) ? data.error : 'no token';
    throw new GitHubAuthError('error', `token exchange: ${err}`);
  }
  return data.access_token;
}

export interface GitHubProfile {
  githubId: number;
  login: string;
  name: string | null;
  email: string;
}

const LOGIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const cleanText = (v: unknown, max: number): string | null => {
  if (typeof v !== 'string') return null;
  const s = v.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max);
  return s || null;
};

/** Fetch the user's id, login, name and primary verified email with the token. */
export async function fetchProfile(token: string): Promise<GitHubProfile> {
  const headers = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'vulnera' };
  const [user, emails] = await Promise.all([
    call(`${apiBase()}/user`, { headers }, 'GitHub user') as Promise<{ id?: unknown; login?: unknown; name?: unknown }>,
    call(`${apiBase()}/user/emails`, { headers }, 'GitHub emails'),
  ]);
  const id = user?.id;
  if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0) throw new GitHubAuthError('error', 'GitHub user: bad id');
  if (typeof user.login !== 'string' || !LOGIN_RE.test(user.login)) throw new GitHubAuthError('error', 'GitHub user: bad login');
  if (!Array.isArray(emails)) throw new GitHubAuthError('error', 'GitHub emails: not a list');
  const primary = emails.find(
    (e): e is { email: string } =>
      !!e && typeof e === 'object' && e.primary === true && e.verified === true && typeof e.email === 'string' && e.email.length <= 320 && /^[^\s@]+@[^\s@]+$/.test(e.email),
  );
  if (!primary) throw new GitHubAuthError('email', 'no primary verified email');
  return { githubId: id, login: user.login, name: cleanText(user.name, 255), email: primary.email };
}
