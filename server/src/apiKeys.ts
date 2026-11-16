import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import express, { Router } from 'express';
import { accountsEnabled } from './auth/config.js';
import { requireSession } from './auth/session.js';
import { query, tx } from './db/pool.js';
import { createLimiter } from './ratelimit.js';

// API keys: vk_<16 hex id>_<43 base64url secret>. Only the sha256 is stored; the secret is shown once at creation.
// Keys are never logged and are accepted only as `Authorization: Bearer`.

const KEY_RE = /^vk_([0-9a-f]{16})_([A-Za-z0-9_-]{43})$/;
const sha256 = (s: string) => createHash('sha256').update(s).digest();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface KeyInfo {
  id: string;
  name: string;
  keyId: string;
  last4: string;
  createdAt: string;
  lastUsedAt: string | null;
}

interface KeyRow {
  id: string;
  name: string;
  key_id: string;
  last4: string;
  created_at: Date;
  last_used_at: Date | null;
}
const toInfo = (r: KeyRow): KeyInfo => ({ id: r.id, name: r.name, keyId: r.key_id, last4: r.last4, createdAt: r.created_at.toISOString(), lastUsedAt: r.last_used_at?.toISOString() ?? null });
const COLS = 'id, name, key_id, last4, created_at, last_used_at';

export class KeyLimitError extends Error {}

/** Creating keys is rate limited per user (not per address): 10 an hour. shortcut: per process, like the other limiters. */
export const KEY_CREATES_PER_HOUR = 10;
export const keyCreateLimiter = createLimiter({ limits: [{ windowMs: 3_600_000, max: KEY_CREATES_PER_HOUR }], maxKeys: 20_000 });

/** Key names: 1 to 60 characters, printable only (letters, marks, digits, punctuation, symbols, plain spaces). No control, format or line-separator characters. */
export const validKeyName = (name: string): boolean => name.length >= 1 && name.length <= 60 && /^[\p{L}\p{M}\p{N}\p{P}\p{S} ]+$/u.test(name);

export async function createKey(userId: string, name: string): Promise<{ key: KeyInfo; secret: string }> {
  const keyId = randomBytes(8).toString('hex');
  const secret = `vk_${keyId}_${randomBytes(32).toString('base64url')}`;
  const row = await tx(async (c) => {
    // Locking the user row makes two parallel requests count keys one after the other.
    const u = await c.query<{ max: number }>('SELECT p.max_api_keys AS max FROM users u JOIN plans p ON p.id = u.plan_id WHERE u.id = $1 FOR UPDATE OF u', [userId]);
    if (!u.rows[0]) throw new Error('user not found');
    const n = await c.query<{ n: string }>('SELECT count(*)::text AS n FROM api_keys WHERE user_id = $1 AND revoked_at IS NULL', [userId]);
    if (Number(n.rows[0]!.n) >= u.rows[0].max) throw new KeyLimitError();
    const r = await c.query<KeyRow>(`INSERT INTO api_keys (user_id, name, key_id, key_hash, last4) VALUES ($1, $2, $3, $4, $5) RETURNING ${COLS}`, [userId, name, keyId, sha256(secret), secret.slice(-4)]);
    return r.rows[0]!;
  });
  return { key: toInfo(row), secret };
}

export async function listKeys(userId: string): Promise<KeyInfo[]> {
  return (await query<KeyRow>(`SELECT ${COLS} FROM api_keys WHERE user_id = $1 AND revoked_at IS NULL ORDER BY created_at DESC, id`, [userId])).map(toInfo);
}

export async function revokeKey(userId: string, id: string): Promise<boolean> {
  if (!UUID.test(id)) return false;
  const rows = await query('UPDATE api_keys SET revoked_at = now() WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL RETURNING id', [id, userId]);
  return rows.length > 0;
}

export const looksLikeKey = (token: string) => KEY_RE.test(token);

/** The owner of a valid, unrevoked key, or null. last_used_at is touched at most once a minute. */
export async function verifyKey(token: string): Promise<{ userId: string; keyId: string; planId: string } | null> {
  const m = KEY_RE.exec(token);
  if (!m) return null;
  const rows = await query<{ id: string; user_id: string; key_hash: Buffer; plan_id: string }>(
    'SELECT k.id, k.user_id, k.key_hash, u.plan_id FROM api_keys k JOIN users u ON u.id = k.user_id WHERE k.key_id = $1 AND k.revoked_at IS NULL',
    [m[1]],
  );
  const r = rows[0];
  if (!r) return null;
  const want = sha256(token);
  if (r.key_hash.length !== want.length || !timingSafeEqual(r.key_hash, want)) return null;
  query("UPDATE api_keys SET last_used_at = now() WHERE id = $1 AND (last_used_at IS NULL OR last_used_at < now() - interval '1 minute')", [r.id]).catch(() => {});
  return { userId: r.user_id, keyId: r.id, planId: r.plan_id };
}

export function keysRouter(): Router {
  const r = Router();
  r.use('/api/keys', (_req, res, next) => (accountsEnabled() ? next() : void res.status(404).json({ error: 'Not found' })), (_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  r.get('/api/keys', requireSession, async (_req, res) => {
    res.json({ keys: await listKeys(res.locals.user.id) });
  });
  r.post('/api/keys', requireSession, express.json({ limit: '4kb' }), async (req, res) => {
    const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    if (!validKeyName(name)) return void res.status(400).json({ error: 'Give the key a name of 1 to 60 printable characters.' });
    const wait = keyCreateLimiter.hit(res.locals.user.id);
    if (wait > 0) {
      res.setHeader('Retry-After', String(wait));
      return void res.status(429).json({ error: `You can create ${KEY_CREATES_PER_HOUR} API keys an hour. Try again in ${Math.max(1, Math.ceil(wait / 60))} minutes.` });
    }
    try {
      res.status(201).json(await createKey(res.locals.user.id, name));
    } catch (e) {
      if (e instanceof KeyLimitError) return void res.status(409).json({ error: 'You have reached the API key limit for your plan. Revoke a key to create another.' });
      throw e;
    }
  });
  r.delete('/api/keys/:id', requireSession, async (req, res) => {
    if (!(await revokeKey(res.locals.user.id, String(req.params.id)))) return void res.status(404).json({ error: 'Key not found.' });
    res.json({ ok: true });
  });
  return r;
}
