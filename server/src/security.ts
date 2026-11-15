import { timingSafeEqual } from 'node:crypto';
import type { ErrorRequestHandler, Request, RequestHandler } from 'express';
import { isProduction } from './env.js';

export const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "font-src 'self' data:",
  "object-src 'none'",
  "base-uri 'self'",
  "frame-ancestors 'none'",
  "form-action 'self'",
].join('; ');

export const securityHeaders: RequestHandler = (req, res, next) => {
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  if (req.secure) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  next();
};

/** Last middleware: JSON errors only, and never a stack trace or internal message in the response. */
export const jsonErrorHandler: ErrorRequestHandler = (err, _req, res, next) => {
  if (res.headersSent) return next(err);
  const e = err as { type?: string; status?: number; statusCode?: number };
  if (e?.type === 'entity.parse.failed') return void res.status(400).json({ error: 'The request body is not valid JSON.' });
  if (e?.type === 'entity.too.large') return void res.status(413).json({ error: 'The upload is too large (limit 10 MB).' });
  const status = e?.status ?? e?.statusCode;
  if (typeof status === 'number' && status >= 400 && status < 500) {
    return void res.status(status).json({ error: 'The request could not be read.' }); // other body-parser problems (encoding, aborted)
  }
  console.error(err);
  res.status(500).json({ error: 'Something went wrong on our side. Please try again.' });
};

const same = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

/** /api/doctor access: open in development; in production it needs the x-admin-token header (404 when ADMIN_TOKEN is unset). */
export function doctorAccess(req: Pick<Request, 'get' | 'socket'>): 'ok' | 'not-found' | 'forbidden' {
  if (!isProduction()) return 'ok';
  // Someone running Vulnera on their own computer may always see it: a direct request from this machine,
  // with no reverse proxy configured in front and no forwarded-for header (which a proxy would add).
  const local = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket?.remoteAddress ?? '');
  if (local && !Number(process.env.TRUST_PROXY) && !req.get('x-forwarded-for')) return 'ok';
  const token = process.env.ADMIN_TOKEN;
  if (!token) return 'not-found';
  return same(req.get('x-admin-token') ?? '', token) ? 'ok' : 'forbidden';
}
