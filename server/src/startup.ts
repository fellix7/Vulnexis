import { buildPoolConfig } from './db/pool.js';

// Checks run once at startup. In production a half-configured accounts setup must stop the server, not quietly run
// without sign-in (or with the wrong cookie rules). Development keeps its forgiving defaults.

/** What is wrong with the accounts setup in production: empty when fine, or when DATABASE_URL is unset (accounts are off). */
export function accountsConfigProblems(env: NodeJS.ProcessEnv = process.env): string[] {
  if (env.NODE_ENV !== 'production' || !env.DATABASE_URL?.trim()) return [];
  const problems: string[] = [];
  if (!env.GITHUB_CLIENT_ID?.trim()) problems.push('GITHUB_CLIENT_ID is missing');
  if (!env.GITHUB_CLIENT_SECRET?.trim()) problems.push('GITHUB_CLIENT_SECRET is missing');
  const origin = env.PUBLIC_ORIGIN?.trim();
  if (!origin) problems.push('PUBLIC_ORIGIN is missing (the site address, e.g. https://vulnera.example.com)');
  else {
    let protocol = '';
    try {
      protocol = new URL(origin).protocol;
    } catch {
      /* reported below */
    }
    if (protocol !== 'https:') problems.push(`PUBLIC_ORIGIN must be an https:// address (got "${origin}")`);
  }
  return problems;
}

/** Throws a clear error when the configuration cannot be run safely. */
export function assertStartupConfig(env: NodeJS.ProcessEnv = process.env): void {
  const problems = accountsConfigProblems(env);
  if (problems.length) {
    throw new Error(`DATABASE_URL is set, so accounts are on, but the configuration is incomplete:\n  - ${problems.join('\n  - ')}`);
  }
  if (env.DATABASE_URL?.trim()) buildPoolConfig(env, () => {}); // TLS settings (DATABASE_SSL=0 on a remote host in production, unreadable CA file)
}

/** Things worth a log line at startup, not worth refusing to start. */
export function startupWarnings(env: NodeJS.ProcessEnv = process.env): string[] {
  const out: string[] = [];
  const budget = Number(env.GEMINI_MONTHLY_BUDGET_INR);
  if (env.NODE_ENV === 'production' && env.GEMINI_API_KEY?.trim() && !(budget > 0)) {
    out.push('GEMINI_API_KEY is set but GEMINI_MONTHLY_BUDGET_INR is 0: there is no monthly cap on Gemini spend. Set GEMINI_MONTHLY_BUDGET_INR (rupees).');
  }
  return out;
}
