import { dbEnabled, query } from './db/pool.js';

// Hourly housekeeping: expired scans and sessions, keys revoked over 30 days ago, and the daily per-IP quota rows (kept until the day after).

export async function sweepOnce(): Promise<{ scans: number; sessions: number; keys: number; ipUsage: number }> {
  const count = async (sql: string) => (await query<{ n: string }>(`WITH d AS (${sql} RETURNING 1) SELECT count(*)::text AS n FROM d`))[0]!.n;
  return {
    scans: Number(await count('DELETE FROM scans WHERE expires_at < now()')),
    sessions: Number(await count('DELETE FROM sessions WHERE expires_at < now()')),
    keys: Number(await count("DELETE FROM api_keys WHERE revoked_at < now() - interval '30 days'")),
    ipUsage: Number(await count(`DELETE FROM usage WHERE subject LIKE 'ip:%' AND period < (now() AT TIME ZONE 'Asia/Kolkata')::date - 1`)),
  };
}

let timer: NodeJS.Timeout | undefined;

export function startSweep(): void {
  if (timer || !dbEnabled()) return;
  const run = () => sweepOnce().catch((e) => console.error('[sweep] failed:', e instanceof Error ? e.message : e));
  timer = setInterval(run, 3_600_000);
  timer.unref();
  setTimeout(run, 60_000).unref();
}
