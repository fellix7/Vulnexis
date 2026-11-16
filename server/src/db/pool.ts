import { readFileSync } from 'node:fs';
import pg from 'pg';

// One Postgres pool per process. DATABASE_URL unset = accounts are off and the app runs as a single-user tool.

let pool: pg.Pool | null = null;

export const dbEnabled = (): boolean => Boolean(process.env.DATABASE_URL?.trim());

export const isLocalHost = (url: string): boolean => {
  try {
    const h = new URL(url).hostname;
    return h === '' || h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '[::1]'; // '' = unix socket
  } catch {
    return false;
  }
};

/** Query parameters that make pg switch TLS on, off or to "trust anything" on its own (sslmode=require/no-verify, sslcert, ...). */
const SSL_PARAM = /^ssl/i;

/** DATABASE_URL without any ssl* parameter, and the names removed. TLS is decided only by DATABASE_SSL and the CA settings. */
export function stripSslParams(url: string): { url: string; removed: string[] } {
  try {
    const u = new URL(url);
    const removed = [...new Set([...u.searchParams.keys()].filter((k) => SSL_PARAM.test(k)))];
    if (!removed.length) return { url, removed };
    for (const k of removed) u.searchParams.delete(k);
    return { url: u.toString(), removed };
  } catch {
    return { url, removed: [] };
  }
}

function readCa(env: NodeJS.ProcessEnv): string | undefined {
  const inline = env.DATABASE_CA_CERT?.trim();
  if (inline) return inline.replace(/\\n/g, '\n'); // allow "\n" written out in a one-line env var
  const file = env.DATABASE_CA_FILE?.trim();
  if (!file) return undefined;
  try {
    return readFileSync(file, 'utf8');
  } catch (e) {
    throw new Error(`DATABASE_CA_FILE ${file} cannot be read: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * The pg pool settings for DATABASE_URL. Remote databases always verify the server certificate (rejectUnauthorized true),
 * against DATABASE_CA_CERT / DATABASE_CA_FILE when given, else Node's default trust store. Local databases get no TLS.
 * DATABASE_SSL=0 on a remote host is refused in production. Throws with a clear message on a bad setup.
 */
export function buildPoolConfig(env: NodeJS.ProcessEnv = process.env, log: (m: string) => void = (m) => console.warn(m)): pg.PoolConfig {
  const raw = env.DATABASE_URL?.trim();
  if (!raw) throw new Error('DATABASE_URL is not set');
  const { url, removed } = stripSslParams(raw);
  if (removed.length) log(`[db] ignoring ${removed.join(', ')} in DATABASE_URL: TLS is set with DATABASE_SSL and DATABASE_CA_FILE / DATABASE_CA_CERT, and a remote database is always verified.`);
  const local = isLocalHost(url);
  const off = env.DATABASE_SSL === '0' || env.DATABASE_SSL === 'false';
  if (off && !local && env.NODE_ENV === 'production') {
    throw new Error('DATABASE_SSL=0 is not allowed in production for a remote database: the connection (and the password) would travel unencrypted. Remove DATABASE_SSL=0.');
  }
  let ssl: pg.PoolConfig['ssl'] = false;
  if (!off && (!local || env.DATABASE_SSL === '1' || env.DATABASE_SSL === 'true')) {
    const ca = readCa(env);
    ssl = ca ? { rejectUnauthorized: true, ca } : { rejectUnauthorized: true };
  }
  return {
    connectionString: url,
    ssl,
    max: Math.max(1, Number(env.DB_POOL_MAX) || 5),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    statement_timeout: 15_000, // no query may hold a connection for long
    application_name: 'vulnera',
  };
}

export function getPool(): pg.Pool {
  if (!dbEnabled()) throw new Error('DATABASE_URL is not set');
  if (!pool) {
    pool = new pg.Pool(buildPoolConfig());
    pool.on('error', (e) => console.error('[db] idle client error:', e.message));
  }
  return pool;
}

/** Run one parameterised statement and return its rows. Never build SQL from user input; always pass params. */
export async function query<T extends pg.QueryResultRow = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  const res = await getPool().query<T>(sql, params);
  return res.rows;
}

/** Run `fn` inside a transaction; rolls back if it throws. */
export async function tx<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

export async function closeDb(): Promise<void> {
  const p = pool;
  pool = null;
  if (p) await p.end();
}
