import { dbEnabled } from '../db/pool.js';
import { isProduction } from '../env.js';

// Accounts are on only when everything they need is configured: a database, a GitHub OAuth app and the public origin.
// Otherwise Vulnera runs as a single-user tool, exactly as before: no sign-in, uploads allowed, auth routes answer 404.

export function publicOrigin(): string | null {
  const raw = process.env.PUBLIC_ORIGIN?.trim() || (isProduction() ? '' : 'http://localhost:5173');
  if (!raw) return null;
  try {
    return new URL(raw).origin; // normalised: scheme://host[:port], no trailing slash or path
  } catch {
    return null;
  }
}

export const accountsEnabled = (): boolean =>
  dbEnabled() && Boolean(process.env.GITHUB_CLIENT_ID?.trim()) && Boolean(process.env.GITHUB_CLIENT_SECRET?.trim()) && publicOrigin() !== null;

/** Cookies get Secure and the __Host- prefix only when the site is served over https. */
export const secureCookies = (): boolean => publicOrigin()?.startsWith('https://') ?? false;
