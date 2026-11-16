import type { RequestHandler } from 'express';
import { looksLikeKey, verifyKey } from './apiKeys.js';
import { accountsEnabled } from './auth/config.js';
import { sessionUser } from './auth/session.js';
import { clientIp, createLimiter } from './ratelimit.js';

// Who is calling: an API key (Authorization: Bearer), a signed-in browser session, or nobody (anonymous).
// With accounts off everyone is anonymous and nothing else changes.

export type Caller =
  | { kind: 'key'; userId: string; keyId: string; planId: string }
  | { kind: 'user'; userId: string; planId: string }
  | { kind: 'anonymous' };

export const callerOf = (res: { locals: Record<string, any> }): Caller => (res.locals.caller as Caller | undefined) ?? { kind: 'anonymous' };

// Failed key lookups per IP (a guessing attempt); good keys never touch this.
const failLimiter = createLimiter({ limits: [{ windowMs: 60_000, max: Number(process.env.AUTH_FAIL_PER_MIN) || 20 }], maxKeys: 20_000 });

export const identify: RequestHandler = async (req, res, next) => {
  try {
    res.locals.caller = { kind: 'anonymous' } satisfies Caller;
    if (!accountsEnabled()) return next();
    if (['key', 'api_key', 'token'].some((p) => req.query[p] !== undefined)) {
      return void res.status(400).json({ error: 'Send API keys in the Authorization header, never in the URL.' });
    }
    const m = /^Bearer\s+(\S+)\s*$/i.exec(req.get('authorization') ?? '');
    if (m) {
      // Verify first: a valid key is never blocked by earlier failures from the same address. Only failures count.
      const k = looksLikeKey(m[1]!) ? await verifyKey(m[1]!) : null;
      if (!k) {
        const wait = failLimiter.hit(clientIp(req));
        if (wait > 0) {
          res.setHeader('Retry-After', String(wait));
          return void res.status(429).json({ error: 'Too many failed attempts. Try again in a minute.' });
        }
        return void res.status(401).json({ error: 'This API key is not valid.' });
      }
      res.locals.caller = { kind: 'key', ...k } satisfies Caller;
      return next();
    }
    const u = await sessionUser(req);
    if (u) res.locals.caller = { kind: 'user', userId: u.id, planId: u.planId } satisfies Caller;
    next();
  } catch (e) {
    next(e);
  }
};

/** 401 unless the caller is an API key (the /v1 routes). */
export const requireKeyCaller: RequestHandler = (_req, res, next) => {
  if (callerOf(res).kind === 'key') return next();
  res.status(401).json({ error: 'Send an API key as "Authorization: Bearer vk_...".' });
};
