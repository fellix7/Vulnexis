import { createHash } from 'node:crypto';
import express, { type RequestHandler } from 'express';
import { accountsEnabled } from './auth/config.js';
import { dbEnabled, query } from './db/pool.js';
import { callerOf } from './caller.js';
import type { PlanInfo, UsageInfo } from './types.js';

export type { PlanInfo, UsageInfo };

// Scan quotas. Signed-in callers use their plan's monthly counter (IST months); anonymous callers (accounts on) use a
// daily counter per IP. The check runs before the request body is read, and is refunded when no scan result is
// delivered (validation failure, sample, queue rejection, cancel while queued, 5xx, deadline).

export interface PlanRow {
  id: string;
  name: string;
  monthly_scans: number;
  daily_scans: number | null;
  max_concurrent: number;
  max_api_keys: number;
  ai_enabled: boolean;
}

const IST_MS = 5.5 * 3_600_000;
const ANON_BODY_MAX = 4096;

const pad = (n: number) => String(n).padStart(2, '0');
const ymd = (d: Date) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;

/** First day of the current month and the current day, both as seen in India (YYYY-MM-DD), plus when each ends (UTC ISO). */
export function istPeriods(now = Date.now()) {
  const ist = new Date(now + IST_MS);
  const y = ist.getUTCFullYear();
  const m = ist.getUTCMonth();
  const d = ist.getUTCDate();
  return {
    month: ymd(new Date(Date.UTC(y, m, 1))),
    day: ymd(new Date(Date.UTC(y, m, d))),
    monthResets: new Date(Date.UTC(y, m + 1, 1) - IST_MS).toISOString(),
    dayResets: new Date(Date.UTC(y, m, d + 1) - IST_MS).toISOString(),
  };
}

export async function getPlan(id: string): Promise<PlanRow> {
  const rows = await query<PlanRow>('SELECT id, name, monthly_scans, daily_scans, max_concurrent, max_api_keys, ai_enabled FROM plans WHERE id = $1', [id]);
  if (rows[0]) return rows[0];
  return (await query<PlanRow>("SELECT id, name, monthly_scans, daily_scans, max_concurrent, max_api_keys, ai_enabled FROM plans WHERE id = 'free'"))[0]!;
}

const planInfo = (p: PlanRow): PlanInfo => ({ id: p.id, name: p.name, monthlyScans: p.monthly_scans, maxConcurrent: p.max_concurrent, maxApiKeys: p.max_api_keys, aiEnabled: p.ai_enabled });

const CONSUME_SQL = `
WITH u AS (
  INSERT INTO usage (subject, period, user_id, scans) SELECT $1::text, $2::date, $3::uuid, 1 WHERE $4::int > 0
  ON CONFLICT (subject, period) DO UPDATE SET scans = usage.scans + 1 WHERE usage.scans < $4::int
  RETURNING scans),
k AS (
  INSERT INTO usage (subject, period, user_id, scans) SELECT $5::text, $2::date, $3::uuid, 1 FROM u WHERE $5::text IS NOT NULL
  ON CONFLICT (subject, period) DO UPDATE SET scans = usage.scans + 1)
SELECT scans FROM u`;

export interface Consumed {
  /** scans used in the period after this one, or null when over the limit */
  scans: number | null;
  refund: () => Promise<void>;
}

/** Take one scan from `subject`'s counter (atomic; never goes above `limit`). `keySubject` is also counted, for display only. */
export async function consume(subject: string, period: string, userId: string | null, limit: number, keySubject: string | null = null): Promise<Consumed> {
  const rows = await query<{ scans: number }>(CONSUME_SQL, [subject, period, userId, limit, keySubject]);
  const scans = rows[0]?.scans ?? null;
  let done = scans === null;
  const refund = async () => {
    if (done) return;
    done = true;
    for (const s of [subject, keySubject]) {
      if (s) await query('UPDATE usage SET scans = scans - 1 WHERE subject = $1 AND period = $2::date AND scans > 0', [s, period]);
    }
  };
  return { scans, refund };
}

const ipSubject = (ip: string, day: string) => `ip:${createHash('sha256').update(`${ip}|${day}`).digest('hex')}`;

export async function planAndUsage(userId: string | null, ip: string): Promise<{ plan: PlanInfo; usage: UsageInfo }> {
  const p = istPeriods();
  if (!dbEnabled()) {
    return {
      plan: { id: 'anonymous', name: 'Anonymous', monthlyScans: 0, maxConcurrent: 2, maxApiKeys: 0, aiEnabled: true },
      usage: { period: p.day, scans: 0, limit: null, resetsAt: p.dayResets },
    };
  }
  if (userId) {
    const row = (await query<PlanRow>('SELECT p.id, p.name, p.monthly_scans, p.daily_scans, p.max_concurrent, p.max_api_keys, p.ai_enabled FROM users u JOIN plans p ON p.id = u.plan_id WHERE u.id = $1', [userId]))[0];
    const plan = row ?? (await getPlan('free'));
    const used = (await query<{ scans: number }>('SELECT scans FROM usage WHERE subject = $1 AND period = $2::date', [`user:${userId}`, p.month]))[0]?.scans ?? 0;
    return { plan: planInfo(plan), usage: { period: p.month, scans: used, limit: plan.monthly_scans, resetsAt: p.monthResets } };
  }
  const plan = await getPlan('anonymous');
  const used = (await query<{ scans: number }>('SELECT scans FROM usage WHERE subject = $1 AND period = $2::date', [ipSubject(ip, p.day), p.day]))[0]?.scans ?? 0;
  return { plan: planInfo(plan), usage: { period: p.day, scans: used, limit: plan.daily_scans ?? 0, resetsAt: p.dayResets } };
}

declare module 'express-serve-static-core' {
  interface Locals {
    plan?: PlanRow;
    refundScan?: () => Promise<void>;
  }
}

/** Give back the scan taken by `admit` (safe to call any number of times, or when nothing was taken). */
export const refund = (res: { locals: Record<string, any> }): Promise<void> => (res.locals.refundScan as (() => Promise<void>) | undefined)?.() ?? Promise.resolve();

const fmtDate = (iso: string) => new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', timeZone: 'Asia/Kolkata' });

const smallJson = express.json({ limit: '4kb' });

/**
 * Quota gate for the scan routes, placed BEFORE the body parser: an over-quota request is answered without reading
 * its body. Does nothing when accounts are off.
 */
export const admit: RequestHandler = async (req, res, next) => {
  try {
    if (!accountsEnabled()) return next();
    const caller = callerOf(res);
    const p = istPeriods();
    const hasLength = req.get('content-length') !== undefined;
    const length = Number(req.get('content-length') ?? 0);
    const chunked = req.get('transfer-encoding') !== undefined;

    let subject: string;
    let period: string;
    let userId: string | null = null;
    let keySubject: string | null = null;
    let limit: number;
    let resetsAt: string;
    let plan: PlanRow;
    if (caller.kind === 'anonymous') {
      // Only {sample:true} or {repoUrl} fit in 4 KB; anything bigger is a lockfile upload, which needs an account.
      if (chunked || (hasLength && !(length <= ANON_BODY_MAX))) {
        return void res.status(401).json({ error: 'Sign in to upload a lockfile.', code: 'signin_required' });
      }
      plan = await getPlan('anonymous');
      subject = ipSubject(req.ip ?? 'unknown', p.day);
      period = p.day;
      limit = plan.daily_scans ?? 0;
      resetsAt = p.dayResets;
    } else {
      plan = await getPlan(caller.planId);
      subject = `user:${caller.userId}`;
      keySubject = caller.kind === 'key' ? `key:${caller.keyId}` : null;
      period = p.month;
      userId = caller.userId;
      limit = plan.monthly_scans;
      resetsAt = p.monthResets;
    }

    const taken = await consume(subject, period, userId, limit, keySubject);
    res.setHeader('X-Quota-Limit', String(limit));
    if (taken.scans === null) {
      res.setHeader('X-Quota-Remaining', '0');
      // The sample scan is never counted, so let a small {sample:true} body through even when the quota is used up.
      if (hasLength && length > 0 && length <= ANON_BODY_MAX && !chunked) {
        const ok = await new Promise<boolean>((resolve) => smallJson(req, res, (e) => resolve(!e)));
        if (ok && req.body?.sample === true && Object.keys(req.body).length === 1) return next();
      }
      const when = caller.kind === 'anonymous' ? 'tomorrow at midnight IST' : `on ${fmtDate(resetsAt)} (IST)`;
      const what = caller.kind === 'anonymous' ? `You have used today's ${limit} free scans from this address.` : `You have used all ${limit} scans on the ${plan.name} plan this month.`;
      res.setHeader('Retry-After', String(Math.max(1, Math.ceil((Date.parse(resetsAt) - Date.now()) / 1000))));
      res.setHeader('Connection', 'close'); // the body was not read; do not wait for it
      return void res.status(429).json({ error: `${what} The quota resets ${when}.${caller.kind === 'anonymous' ? ' Sign in for more.' : ''}`, code: 'quota_exceeded' });
    }
    res.setHeader('X-Quota-Remaining', String(Math.max(0, limit - taken.scans)));
    res.locals.plan = plan;
    res.locals.refundScan = () => taken.refund().catch((e) => console.error('[quota] refund failed:', e instanceof Error ? e.message : e));
    next();
  } catch (e) {
    next(e);
  }
};
