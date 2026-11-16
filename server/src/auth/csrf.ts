import type { RequestHandler } from 'express';
import { accountsEnabled, publicOrigin } from './config.js';
import { hasBearer, hasSessionCookie } from './session.js';

// Cross-site request forgery guard for state-changing requests. SameSite=Lax already keeps the session cookie off
// cross-site POSTs in current browsers; this is the second lock, and the one that also covers same-site siblings
// (another subdomain is "same-site" for SameSite but not same-origin here).
//
// Design scope is non-GET /api/* and /v1/*. It is applied to every unsafe method on every path instead: Express
// matches routes case-insensitively, so a prefix check on the raw path ("/API/me", "//api/me") could be skipped,
// and no route in this app needs to accept a cross-site POST.

const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);
const BLOCKED = { error: 'This request came from another site and was blocked.' };

export const sameOrigin: RequestHandler = (req, res, next) => {
  if (SAFE.has(req.method)) return next();
  if (!accountsEnabled()) return next(); // single-user mode: unchanged behaviour

  // API keys are sent only in this header, which a browser never adds on its own and which a cross-site page
  // cannot set without a CORS preflight that this server never approves. sessionUser() ignores the cookie on any
  // request that passes this test, and caller.ts rejects a bad key with 401, so skipping here cannot let a forged
  // request ride the session.
  if (hasBearer(req)) return next();

  const site = req.get('sec-fetch-site');
  const origin = req.get('origin');
  if (site === 'same-origin') return next();
  const expected = publicOrigin();
  if (origin && expected && origin === expected) return next();

  // No browser signal at all: curl, scripts, old clients. Fine without a cookie (nothing to ride on);
  // refused with one, since that cookie is what a forged request would be using.
  if (site === undefined && origin === undefined && !hasSessionCookie(req)) return next();

  res.setHeader('Cache-Control', 'no-store');
  res.status(403).json(BLOCKED);
};
