import express, { Router, type RequestHandler } from 'express';
import { accountsEnabled } from './auth/config.js';
import { dbEnabled, query } from './db/pool.js';
import { callerOf, identify, requireKeyCaller } from './caller.js';
import type { ScanResult } from './types.js';

// Saved scan history. Source code is never stored: every citation `quote` is blanked before saving.
// Every query is scoped with `WHERE id = $1 AND user_id = $2`, so another user's id answers 404.

export const MAX_RESULT_BYTES = 2 * 1024 * 1024;
export const MAX_REVIEW_BYTES = 64 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const retentionDays = () => Math.max(1, Number(process.env.SCAN_RETENTION_DAYS) || 90);
const bytes = (v: unknown) => Buffer.byteLength(JSON.stringify(v));

/** Deep copy with every `quote` string blanked; the object that held it gets `quoteStored: false`. */
export function stripQuotes<T>(value: T): T {
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v)) out[k] = k === 'quote' && typeof x === 'string' ? '' : walk(x);
      if (typeof (v as Record<string, unknown>).quote === 'string') out.quoteStored = false;
      return out;
    }
    return v;
  };
  return walk(value) as T;
}

/** The copy to store: quotes stripped, then fitted under 2 MB (drop agent steps, then trim advisory details). Null = still too big. */
export function prepareForStorage(result: ScanResult): { stored: ScanResult; size: number } | null {
  const stored = stripQuotes(result);
  delete stored.scanId;
  let size = bytes(stored);
  if (size <= MAX_RESULT_BYTES) return { stored, size };
  delete stored.agent;
  stored.notes = [...stored.notes, 'Saved copy: the agent steps were left out to keep this scan small.'];
  size = bytes(stored);
  const note = 'Saved copy: advisory details were shortened to keep this scan small.';
  for (const keep of [400, 100, 0]) {
    if (size <= MAX_RESULT_BYTES) break;
    for (const f of stored.findings) f.advisory.details = f.advisory.details.slice(0, keep);
    if (!stored.notes.includes(note)) stored.notes.push(note);
    size = bytes(stored);
  }
  return size <= MAX_RESULT_BYTES ? { stored, size } : null;
}

export const TOO_BIG_NOTE = 'This scan is too large to save to your history. The result above is complete; it will not appear in History.';

/** Save a finished scan; returns the new id, or null when it was too large to store. */
export async function save(userId: string, keyId: string | null, source: 'upload' | 'repo', projectName: string, result: ScanResult): Promise<string | null> {
  const prepared = prepareForStorage(result);
  if (!prepared) return null;
  const { stored, size } = prepared;
  const rows = await query<{ id: string }>(
    `INSERT INTO scans (user_id, api_key_id, source, project_name, package_count, finding_count, fix_now_count, ai_status, result, result_bytes, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, now() + make_interval(days => $11::int)) RETURNING id`,
    [userId, keyId, source, projectName.slice(0, 200), stored.packageCount, stored.findings.length, stored.findings.filter((f) => f.tier === 'FIX_NOW').length, stored.aiStatus, JSON.stringify(stored), size, retentionDays()],
  );
  return rows[0]!.id;
}

export interface ScanSummary {
  id: string;
  source: 'upload' | 'repo';
  projectName: string;
  packageCount: number;
  findingCount: number;
  fixNowCount: number;
  aiStatus: string;
  createdAt: string;
  expiresAt: string;
}

interface SummaryRow {
  id: string;
  source: 'upload' | 'repo';
  project_name: string;
  package_count: number;
  finding_count: number;
  fix_now_count: number;
  ai_status: string;
  created_at: Date;
  expires_at: Date;
}
const SUMMARY_COLS = 'id, source, project_name, package_count, finding_count, fix_now_count, ai_status, created_at, expires_at';
const summary = (r: SummaryRow): ScanSummary => ({
  id: r.id,
  source: r.source,
  projectName: r.project_name,
  packageCount: r.package_count,
  findingCount: r.finding_count,
  fixNowCount: r.fix_now_count,
  aiStatus: r.ai_status,
  createdAt: r.created_at.toISOString(),
  expiresAt: r.expires_at.toISOString(),
});

const TS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const encodeCursor = (ts: string, id: string) => Buffer.from(JSON.stringify([ts, id])).toString('base64url');
function decodeCursor(c: string): [string, string] | null {
  try {
    const v = JSON.parse(Buffer.from(c, 'base64url').toString('utf8'));
    return Array.isArray(v) && typeof v[0] === 'string' && typeof v[1] === 'string' && TS_RE.test(v[0]) && UUID.test(v[1]) ? [v[0], v[1]] : null;
  } catch {
    return null;
  }
}

export class BadCursorError extends Error {}

/** Newest first; keyset pagination on (created_at, id) so pages stay stable while scans are added or deleted. */
export async function list(userId: string, limit = 20, cursor?: string): Promise<{ scans: ScanSummary[]; nextCursor: string | null }> {
  const n = Math.min(50, Math.max(1, Math.floor(limit) || 20));
  const cur = cursor ? decodeCursor(cursor) : null;
  if (cursor && !cur) throw new BadCursorError();
  const rows = await query<SummaryRow & { ts: string }>(
    `SELECT ${SUMMARY_COLS}, to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS ts
     FROM scans WHERE user_id = $1 AND expires_at > now() AND ($2::timestamptz IS NULL OR (created_at, id) < ($2::timestamptz, $3::uuid))
     ORDER BY created_at DESC, id DESC LIMIT $4`,
    [userId, cur?.[0] ?? null, cur?.[1] ?? null, n + 1],
  );
  const page = rows.slice(0, n);
  const last = page[page.length - 1];
  return { scans: page.map(summary), nextCursor: rows.length > n && last ? encodeCursor(last.ts, last.id) : null };
}

export async function get(userId: string, id: string): Promise<(ScanSummary & { result: ScanResult; review: unknown }) | null> {
  if (!UUID.test(id)) return null;
  const rows = await query<SummaryRow & { result: ScanResult; review: unknown }>(`SELECT ${SUMMARY_COLS}, result, review FROM scans WHERE id = $1 AND user_id = $2 AND expires_at > now()`, [id, userId]);
  const r = rows[0];
  if (!r) return null;
  return { ...summary(r), result: { ...r.result, scanId: r.id }, review: r.review };
}

export async function remove(userId: string, id: string): Promise<boolean> {
  if (!UUID.test(id)) return false;
  return (await query('DELETE FROM scans WHERE id = $1 AND user_id = $2 RETURNING id', [id, userId])).length > 0;
}

export class ReviewTooBigError extends Error {}

export async function putReview(userId: string, id: string, review: unknown): Promise<boolean> {
  if (bytes(review) > MAX_REVIEW_BYTES) throw new ReviewTooBigError();
  if (!UUID.test(id)) return false;
  return (await query('UPDATE scans SET review = $3::jsonb WHERE id = $1 AND user_id = $2 RETURNING id', [id, userId, JSON.stringify(review)])).length > 0;
}

// ---------- routes ----------

const noStore: RequestHandler = (_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
};

const needAccounts: RequestHandler = (_req, res, next) => (accountsEnabled() && dbEnabled() ? next() : void res.status(404).json({ error: 'Not found' }));

const signedIn: RequestHandler = (_req, res, next) => {
  const c = callerOf(res);
  if (c.kind === 'anonymous') return void res.status(401).json({ error: 'Sign in to see your saved scans.' });
  next();
};

const owner = (res: { locals: Record<string, any> }): string => (callerOf(res) as { userId: string }).userId;

function scansRouter(): Router {
  const r = Router();
  r.get('/', async (req, res) => {
    const limit = Number(req.query.limit) || 20;
    const cursor = typeof req.query.cursor === 'string' && req.query.cursor ? req.query.cursor : undefined;
    try {
      res.json(await list(owner(res), limit, cursor));
    } catch (e) {
      if (e instanceof BadCursorError) return void res.status(400).json({ error: 'The cursor is not valid.' });
      throw e;
    }
  });
  r.get('/:id', async (req, res) => {
    const s = await get(owner(res), String(req.params.id));
    if (!s) return void res.status(404).json({ error: 'Scan not found.' });
    res.json(s);
  });
  r.delete('/:id', async (req, res) => {
    if (!(await remove(owner(res), String(req.params.id)))) return void res.status(404).json({ error: 'Scan not found.' });
    res.json({ ok: true });
  });
  r.put(
    '/:id/review',
    (_req, res, next) => (callerOf(res).kind === 'user' ? next() : void res.status(401).json({ error: 'Sign in to save a review.' })),
    (req, res, next) =>
      express.json({ limit: '80kb' })(req, res, (e) => (!e ? next() : (e as { type?: string }).type === 'entity.too.large' ? void res.status(413).json({ error: 'The review is larger than 64 KB.' }) : next(e))),
    async (req, res) => {
      if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body) || req.body.review === undefined) return void res.status(400).json({ error: 'Send { "review": { ... } }.' });
      try {
        if (!(await putReview(owner(res), String(req.params.id), req.body.review))) return void res.status(404).json({ error: 'Scan not found.' });
        res.json({ ok: true });
      } catch (e) {
        if (e instanceof ReviewTooBigError) return void res.status(413).json({ error: 'The review is larger than 64 KB.' });
        throw e;
      }
    },
  );
  return r;
}

/** Mount points: `/api/scans` (session or key) and `/v1/scans` (key only). CSRF for the session writes is applied by index.ts. */
export function scansRoutes(): Router {
  const r = Router();
  r.use('/api/scans', needAccounts, noStore, identify, signedIn, scansRouter());
  r.use('/v1/scans', needAccounts, noStore, identify, requireKeyCaller, scansRouter());
  return r;
}
