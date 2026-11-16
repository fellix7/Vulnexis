import pg from 'pg';

// One Postgres pool per process. DATABASE_URL unset = accounts are off and the app runs as a single-user tool.

let pool: pg.Pool | null = null;

export const dbEnabled = (): boolean => Boolean(process.env.DATABASE_URL?.trim());

const isLocalHost = (url: string) => {
  try {
    const h = new URL(url).hostname;
    return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '[::1]';
  } catch {
    return false;
  }
};

export function getPool(): pg.Pool {
  if (!dbEnabled()) throw new Error('DATABASE_URL is not set');
  if (!pool) {
    const url = process.env.DATABASE_URL!.trim();
    const sslSetting = process.env.DATABASE_SSL;
    const ssl = sslSetting === '0' || sslSetting === 'false' ? false : sslSetting === '1' || !isLocalHost(url) ? { rejectUnauthorized: false } : false;
    pool = new pg.Pool({
      connectionString: url,
      ssl,
      max: Math.max(1, Number(process.env.DB_POOL_MAX) || 5),
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
      statement_timeout: 15_000, // no query may hold a connection for long
      application_name: 'vulnera',
    });
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
