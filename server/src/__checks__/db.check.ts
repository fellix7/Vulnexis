// Run: DATABASE_URL=postgres://vulnera:vulnera-dev@127.0.0.1:5432/vulnera_test npx tsx server/src/__checks__/db.check.ts
// The database foundation: migrations apply once and are idempotent, cascades work, the test reset refuses real databases.
import assert from 'node:assert/strict';
import { migrate } from '../db/migrate.js';
import { closeDb, dbEnabled, query, tx } from '../db/pool.js';
import { makeUser, resetDb } from '../db/testdb.js';

if (!dbEnabled()) {
  console.log('SKIP db checks: DATABASE_URL is not set');
  process.exit(0);
}

try {
  await resetDb();
  assert.deepEqual(await migrate(() => {}), [], 'second run applies nothing');
  const plans = await query<{ id: string; active: boolean }>('SELECT id, active FROM plans ORDER BY id');
  assert.deepEqual(plans.map((p) => `${p.id}:${p.active}`), ['anonymous:true', 'free:true', 'pro:false']);
  console.log('ok  migrations are idempotent and seed the plans');

  const u = await makeUser();
  await query(`INSERT INTO sessions (id_hash, user_id, expires_at) VALUES ('\\x01', $1, now() + interval '1 day')`, [u.id]);
  await query(`INSERT INTO api_keys (user_id, name, key_id, key_hash, last4) VALUES ($1, 'ci', 'abcd', '\\x02', 'wxyz')`, [u.id]);
  await query(
    `INSERT INTO scans (user_id, source, project_name, package_count, finding_count, fix_now_count, ai_status, result, result_bytes)
     VALUES ($1, 'upload', 'p', 1, 0, 0, 'disabled', '{}', 2)`,
    [u.id],
  );
  await query(`INSERT INTO usage (subject, period, user_id, scans) VALUES ($1, current_date, $2, 1)`, [`user:${u.id}`, u.id]);
  await query('DELETE FROM users WHERE id = $1', [u.id]);
  for (const t of ['sessions', 'api_keys', 'scans', 'usage']) {
    const [{ n }] = await query<{ n: string }>(`SELECT count(*) AS n FROM ${t}`);
    assert.equal(Number(n), 0, `${t} emptied by the cascade`);
  }
  console.log('ok  deleting a user removes their sessions, keys, scans and usage');

  await assert.rejects(
    tx(async (c) => {
      await c.query(`INSERT INTO users (github_id, github_login) VALUES (1, 'a')`);
      throw new Error('boom');
    }),
    /boom/,
  );
  assert.equal((await query('SELECT 1 FROM users WHERE github_id = 1')).length, 0, 'rolled back');
  console.log('ok  tx rolls back on error');

  const saved = process.env.DATABASE_URL;
  process.env.DATABASE_URL = 'postgres://x:y@db.example.com:5432/prod';
  await assert.rejects(resetDb(), /refuses/);
  process.env.DATABASE_URL = saved;
  console.log('ok  resetDb refuses a non-local or non-test database');
  console.log('ALL DB CHECKS PASSED');
} finally {
  await closeDb();
}
