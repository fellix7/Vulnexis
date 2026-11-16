import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { getPool } from './pool.js';

// Plain numbered SQL files in server/migrations, applied in order, each in its own transaction, recorded in
// schema_migrations. An advisory lock keeps two containers starting at once from applying the same file twice.
// (Use Supabase's session pooler on port 5432: the transaction pooler does not keep advisory locks.)

const MIGRATIONS_DIR = path.resolve(import.meta.dirname, '../../migrations');
const LOCK_KEY = 4_213_377_001; // arbitrary constant shared by every Vulnera process

export async function migrate(log: (m: string) => void = (m) => console.log(m)): Promise<string[]> {
  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => /^\d{3}_[\w-]+\.sql$/.test(f)).sort();
  const client = await getPool().connect();
  const applied: string[] = [];
  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]);
    await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
    const done = new Set((await client.query<{ version: string }>('SELECT version FROM schema_migrations')).rows.map((r) => r.version));
    for (const file of files) {
      if (done.has(file)) continue;
      const sql = await readFile(path.join(MIGRATIONS_DIR, file), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [file]);
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        throw new Error(`Migration ${file} failed: ${e instanceof Error ? e.message : String(e)}`);
      }
      applied.push(file);
      log(`[db] applied ${file}`);
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => {});
    client.release();
  }
  return applied;
}

// `npm run migrate -w server`
if (process.argv[1] && /migrate\.(ts|js)$/.test(process.argv[1])) {
  const { closeDb } = await import('./pool.js');
  migrate()
    .then((a) => console.log(a.length ? `[db] ${a.length} migration(s) applied` : '[db] up to date'))
    .catch((e) => {
      console.error(e instanceof Error ? e.message : e);
      process.exitCode = 1;
    })
    .finally(() => closeDb());
}
