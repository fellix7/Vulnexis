import { randomInt } from 'node:crypto';
import { migrate } from './migrate.js';
import { query } from './pool.js';

// Test helpers. They refuse to touch anything but a local database whose name ends in _test or _dev,
// so a mistyped DATABASE_URL can never wipe a real one.

function assertDisposable() {
  const url = process.env.DATABASE_URL ?? '';
  let host = '';
  let db = '';
  try {
    const u = new URL(url);
    host = u.hostname;
    db = u.pathname.replace(/^\//, '');
  } catch {
    /* falls through to the refusal */
  }
  const local = host === 'localhost' || host === '127.0.0.1' || host === '::1';
  if (!local || !/_(test|dev)$/.test(db)) {
    throw new Error(`resetDb refuses to run against ${host || '?'}/${db || '?'}: only local databases named *_test or *_dev`);
  }
}

/** Empty every table (plans are re-seeded by the migration) and make sure the schema is current. */
export async function resetDb(): Promise<void> {
  assertDisposable();
  await migrate(() => {});
  await query('TRUNCATE users, sessions, api_keys, scans, usage, ai_usage RESTART IDENTITY CASCADE');
  await query(`UPDATE plans SET monthly_scans = d.m, daily_scans = d.d, max_concurrent = d.c, max_api_keys = d.k, ai_enabled = d.ai, active = d.a
               FROM (VALUES ('anonymous', 60, 2, 1, 0, true, false), ('free', 30, NULL::int, 2, 3, true, true), ('pro', 500, NULL::int, 4, 10, false, true))
                    AS d(id, m, d, c, k, a, ai)
               WHERE plans.id = d.id`);
}

export interface TestUser {
  id: string;
  github_id: number;
  github_login: string;
  name: string | null;
  email: string | null;
  plan_id: string;
}

/** Insert a user and return it. */
export async function makeUser(over: Partial<Omit<TestUser, 'id'>> = {}): Promise<TestUser> {
  assertDisposable();
  const n = randomInt(1, 2 ** 31);
  const rows = await query<TestUser>(
    `INSERT INTO users (github_id, github_login, name, email, plan_id) VALUES ($1, $2, $3, $4, $5)
     RETURNING id, github_id, github_login, name, email, plan_id`,
    [over.github_id ?? n, over.github_login ?? `user${n}`, over.name ?? null, over.email ?? `user${n}@example.com`, over.plan_id ?? 'free'],
  );
  return rows[0]!;
}
