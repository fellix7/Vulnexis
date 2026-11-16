import type { Request, RequestHandler } from 'express';

// Sliding-window rate limiter, no dependencies. Keyed by client key (the IP for now; later an API key).
// shortcut: per-process memory; behind several instances, limit at the proxy as well.

/** Rate-limit and queue identity: the API key or user once the caller is known, else the IP address. */
export function clientKey(req: Pick<Request, 'ip'> & { res?: { locals?: Record<string, any> } }): string {
  const c = req.res?.locals?.caller as { kind?: string; keyId?: string; userId?: string } | undefined;
  if (c?.kind === 'key' && c.keyId) return `key:${c.keyId}`;
  if (c?.kind === 'user' && c.userId) return `user:${c.userId}`;
  return req.ip ?? 'unknown';
}

/**
 * A direct request from this computer, with no reverse proxy configured in front and no forwarded-for header
 * (which a proxy would add). On a public server every user arrives from another address, or through the proxy.
 */
export function isOwnMachine(req: Pick<Request, 'get' | 'socket'>): boolean {
  const local = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket?.remoteAddress ?? '');
  return local && !Number(process.env.TRUST_PROXY) && !req.get('x-forwarded-for');
}

export interface Limit {
  windowMs: number;
  max: number;
}

export interface LimiterOptions {
  limits: Limit[];
  /** most keys tracked at once; the least recently used are dropped beyond it */
  maxKeys?: number;
  message?: (minutes: number) => string;
  now?: () => number;
}

export function createLimiter(o: LimiterOptions) {
  const maxKeys = o.maxKeys ?? 50_000;
  const now = o.now ?? Date.now;
  const longest = Math.max(...o.limits.map((l) => l.windowMs));
  const hits = new Map<string, number[]>(); // Map order = least recently used first

  /** Records a hit and returns 0, or the seconds to wait when over a limit (the hit is then not recorded). */
  function hit(key: string): number {
    const t = now();
    const list = (hits.get(key) ?? []).filter((x) => x > t - longest);
    let wait = 0;
    for (const l of o.limits) {
      const inWin = list.filter((x) => x > t - l.windowMs);
      if (inWin.length >= l.max) wait = Math.max(wait, Math.ceil((inWin[inWin.length - l.max]! + l.windowMs - t) / 1000));
    }
    hits.delete(key);
    if (wait === 0) list.push(t);
    if (list.length) {
      hits.set(key, list);
      if (hits.size > maxKeys) hits.delete(hits.keys().next().value!);
    }
    return wait;
  }

  /** Seconds to wait when the key is over a limit, without recording a hit. */
  function peek(key: string): number {
    const t = now();
    const list = hits.get(key) ?? [];
    let wait = 0;
    for (const l of o.limits) {
      const inWin = list.filter((x) => x > t - l.windowMs);
      if (inWin.length >= l.max) wait = Math.max(wait, Math.ceil((inWin[inWin.length - l.max]! + l.windowMs - t) / 1000));
    }
    return wait;
  }

  function sweep() {
    const t = now();
    for (const [k, list] of hits) if (list[list.length - 1]! <= t - longest) hits.delete(k);
  }
  const timer = setInterval(sweep, 60_000);
  timer.unref();

  const middleware: RequestHandler = (req, res, next) => {
    if (isOwnMachine(req)) return next(); // running Vulnera on your own computer: no limits on yourself
    const wait = hit(clientKey(req));
    if (wait === 0) return next();
    const minutes = Math.max(1, Math.ceil(wait / 60));
    res.setHeader('Retry-After', String(wait));
    res.status(429).json({ error: o.message ? o.message(minutes) : `Too many scans from this address. Try again in ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}.` });
  };
  return Object.assign(middleware, { hit, peek, sweep, size: () => hits.size });
}
