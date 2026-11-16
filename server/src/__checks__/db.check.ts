// Run: DATABASE_URL=postgres://vulnera:vulnera-dev@127.0.0.1:5432/vulnera_test npx tsx server/src/__checks__/db.check.ts
// The database foundation: migrations apply once and are idempotent, cascades work, the test reset refuses real databases.
import assert from 'node:assert/strict';
import { rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { migrate } from '../db/migrate.js';
import { buildPoolConfig, closeDb, dbEnabled, query, tx } from '../db/pool.js';
import { makeUser, resetDb } from '../db/testdb.js';

// A1: TLS settings (pure; no database needed)
{
  const logged: string[] = [];
  const log = (m: string) => logged.push(m);
  const remote = { DATABASE_URL: 'postgres://u:p@db.abc.supabase.co:5432/postgres' } as NodeJS.ProcessEnv;
  assert.deepEqual(buildPoolConfig(remote, log).ssl, { rejectUnauthorized: true }, 'remote: verified, default trust store');
  assert.deepEqual(buildPoolConfig({ ...remote, NODE_ENV: 'production' }, log).ssl, { rejectUnauthorized: true });
  const pem = '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----';
  assert.deepEqual(buildPoolConfig({ ...remote, DATABASE_CA_CERT: pem }, log).ssl, { rejectUnauthorized: true, ca: pem });
  assert.equal((buildPoolConfig({ ...remote, DATABASE_CA_CERT: pem.replaceAll('\n', '\\n') }, log).ssl as { ca: string }).ca, pem, 'one-line env var with \\n');
  const caFile = path.join(tmpdir(), `vulnera-ca-${process.pid}.pem`);
  writeFileSync(caFile, pem);
  assert.deepEqual(buildPoolConfig({ ...remote, DATABASE_CA_FILE: caFile }, log).ssl, { rejectUnauthorized: true, ca: pem });
  rmSync(caFile);
  assert.throws(() => buildPoolConfig({ ...remote, DATABASE_CA_FILE: caFile }, log), /DATABASE_CA_FILE/, 'unreadable CA file');
  for (const local of ['postgres://u:p@localhost:5432/d', 'postgres://u:p@127.0.0.1:5432/d', 'postgres://u:p@[::1]:5432/d']) {
    assert.equal(buildPoolConfig({ DATABASE_URL: local }, log).ssl, false, `no TLS for ${local}`);
  }
  assert.equal(buildPoolConfig({ ...remote, DATABASE_SSL: '0' }, log).ssl, false, 'remote with TLS off is allowed outside production');
  assert.throws(() => buildPoolConfig({ ...remote, DATABASE_SSL: '0', NODE_ENV: 'production' }, log), /DATABASE_SSL=0/);
  assert.throws(() => buildPoolConfig({ ...remote, DATABASE_SSL: 'false', NODE_ENV: 'production' }, log), /not allowed in production/);
  assert.equal(buildPoolConfig({ DATABASE_URL: 'postgres://u:p@127.0.0.1:5432/d', DATABASE_SSL: '0', NODE_ENV: 'production' }, log).ssl, false, 'local + TLS off is fine in production');
  assert.equal(logged.length, 0, 'nothing logged without ssl parameters');
  const risky = buildPoolConfig({ DATABASE_URL: 'postgres://u:p%40@db.example.com:5432/d?sslmode=no-verify&application_name=x&sslrootcert=/tmp/a' } as NodeJS.ProcessEnv, log);
  assert.ok(!/ssl/i.test(risky.connectionString!), `ssl parameters stripped: ${risky.connectionString}`);
  assert.match(risky.connectionString!, /application_name=x/, 'other parameters kept');
  assert.match(risky.connectionString!, /u:p%40@/, 'credentials untouched');
  assert.deepEqual(risky.ssl, { rejectUnauthorized: true }, 'sslmode=no-verify cannot weaken it');
  assert.equal(logged.length, 1);
  assert.match(logged[0]!, /ignoring sslmode, sslrootcert/);
  console.log('ok  database TLS: remote verified, local plain, DATABASE_SSL=0 refused in production, ssl* URL parameters ignored');
}

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

  // A7 + A4: every table in public has row level security (schema_migrations included); anonymous has no AI
  const noRls = await query<{ relname: string }>(
    `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND NOT c.relrowsecurity`,
  );
  assert.deepEqual(noRls, [], 'every table in public has row level security');
  assert.ok((await query('SELECT 1 FROM pg_class WHERE relname = $1 AND relrowsecurity', ['schema_migrations'])).length === 1, 'schema_migrations in particular');
  assert.ok((await query('SELECT 1 FROM schema_migrations WHERE version = $1', ['002_security.sql'])).length === 1, '002 recorded');
  assert.equal((await query<{ ai_enabled: boolean }>("SELECT ai_enabled FROM plans WHERE id = 'anonymous'"))[0]!.ai_enabled, false, 'anonymous has no AI code check');
  assert.equal((await query<{ ai_enabled: boolean }>("SELECT ai_enabled FROM plans WHERE id = 'free'"))[0]!.ai_enabled, true);
  console.log('ok  row level security on every public table; anonymous plan has no AI');

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
