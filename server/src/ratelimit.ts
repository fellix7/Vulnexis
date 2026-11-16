import { isIPv4, isIPv6 } from 'node:net';
import type { Request, RequestHandler } from 'express';

// Sliding-window rate limiter, no dependencies. Keyed by client key (the IP for now; later an API key).
// shortcut: per-process memory; behind several instances, limit at the proxy as well.

// ---- client address ---------------------------------------------------------------------------------------------

/** 4 bytes (IPv4) or 16 bytes (IPv6) of an address; IPv4-mapped IPv6 (::ffff:a.b.c.d) comes back as its 4 IPv4 bytes. Null if not an IP. */
export function parseIp(input: string): number[] | null {
  let s = input.trim();
  const zone = s.indexOf('%');
  if (zone >= 0) s = s.slice(0, zone);
  if (isIPv4(s)) return s.split('.').map(Number);
  if (!isIPv6(s)) return null;
  const tail = /^(.*:)(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (tail) {
    const v = tail[2]!.split('.').map(Number);
    s = `${tail[1]}${((v[0]! << 8) | v[1]!).toString(16)}:${((v[2]! << 8) | v[3]!).toString(16)}`;
  }
  const gap = s.indexOf('::');
  const left = (gap < 0 ? s : s.slice(0, gap)).split(':').filter(Boolean);
  const right = gap < 0 ? [] : s.slice(gap + 2).split(':').filter(Boolean);
  const groups = gap < 0 ? left : [...left, ...Array<string>(8 - left.length - right.length).fill('0'), ...right];
  if (groups.length !== 8) return null;
  const bytes = groups.flatMap((g) => {
    const n = parseInt(g, 16);
    return [n >> 8, n & 255];
  });
  if (bytes.slice(0, 10).every((b) => b === 0) && bytes[10] === 255 && bytes[11] === 255) return bytes.slice(12);
  return bytes;
}

/**
 * The identity an address is limited under: IPv4 as is, IPv4-mapped IPv6 as its IPv4 address, any other IPv6 as its /64
 * prefix (one customer line holds a whole /64, so single addresses would let one client dodge every limit).
 * Anything that is not an IP (including an identity this function already produced) comes back unchanged.
 */
export function normalizeIp(ip: string): string {
  const b = parseIp(ip);
  if (!b) return ip;
  if (b.length === 4) return b.join('.');
  const g = [0, 1, 2, 3].map((i) => ((b[2 * i]! << 8) | b[2 * i + 1]!).toString(16));
  return `${g.join(':')}::/64`;
}

export interface Cidr {
  bytes: number[];
  bits: number;
}

/** "10.0.0.0/8", "2400:cb00::/32" or a bare address (a single host). Null when malformed. */
export function parseCidr(input: string): Cidr | null {
  const [addr, len, extra] = input.trim().split('/');
  if (!addr || extra !== undefined) return null;
  const bytes = parseIp(addr);
  if (!bytes) return null;
  const mapped = bytes.length === 4 && isIPv6(addr.trim()); // ::ffff:1.2.3.4/120 style: prefix counts in the 128-bit form
  const max = bytes.length * 8;
  let bits = len === undefined ? max : /^\d{1,3}$/.test(len) ? Number(len) : -1;
  if (mapped && len !== undefined) bits -= 96;
  return bits < 0 || bits > max ? null : { bytes, bits };
}

export function ipInCidr(ip: string, c: Cidr): boolean {
  const b = parseIp(ip);
  if (!b || b.length !== c.bytes.length) return false;
  let left = c.bits;
  for (let i = 0; left > 0; i++, left -= 8) {
    const mask = left >= 8 ? 255 : (255 << (8 - left)) & 255;
    if ((b[i]! & mask) !== (c.bytes[i]! & mask)) return false;
  }
  return true;
}

let cidrCache: { src: string; list: Cidr[] } | undefined;
/** TRUSTED_PROXY_CIDRS: comma-separated CIDRs (parsed once per value; malformed entries are skipped with a warning). */
function trustedCidrs(): Cidr[] {
  const src = process.env.TRUSTED_PROXY_CIDRS ?? '';
  if (cidrCache?.src !== src) {
    const list: Cidr[] = [];
    for (const part of src.split(',').map((x) => x.trim()).filter(Boolean)) {
      const c = parseCidr(part);
      if (c) list.push(c);
      else console.warn(`[net] TRUSTED_PROXY_CIDRS: ignoring "${part}" (not a CIDR)`);
    }
    cidrCache = { src, list };
  }
  return cidrCache.list;
}

export interface IpRequest {
  ip?: string;
  socket?: { remoteAddress?: string };
  headers?: Record<string, string | string[] | undefined>;
}

/**
 * The one place that decides which address a request is from (rate limiter, anonymous quota, sign-in limiter).
 *  - TRUSTED_CLIENT_IP_HEADER set (e.g. cf-connecting-ip): that header is believed ONLY when the socket peer is inside
 *    TRUSTED_PROXY_CIDRS; from any other peer it is ignored and the socket address is used.
 *  - Otherwise Express's `req.ip`, so TRUST_PROXY behaves as before.
 * The result is normalised: IPv4, or the /64 prefix of an IPv6 address.
 */
export function clientIp(req: IpRequest): string {
  const peer = req.socket?.remoteAddress;
  const header = process.env.TRUSTED_CLIENT_IP_HEADER?.trim().toLowerCase();
  if (header) {
    if (peer && trustedCidrs().some((c) => ipInCidr(peer, c))) {
      const raw = req.headers?.[header];
      const v = (Array.isArray(raw) ? raw[0] : raw)?.trim();
      if (v && parseIp(v)) return normalizeIp(v);
    }
    return normalizeIp(peer ?? 'unknown');
  }
  return normalizeIp(req.ip ?? peer ?? 'unknown');
}

/** Rate-limit and queue identity: the user (keys belong to a user, so a user's keys share one bucket), else the client address. */
export function clientKey(req: IpRequest & { res?: { locals?: Record<string, any> } }): string {
  const c = req.res?.locals?.caller as { kind?: string; userId?: string } | undefined;
  if ((c?.kind === 'key' || c?.kind === 'user') && c.userId) return `user:${c.userId}`;
  return clientIp(req);
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
