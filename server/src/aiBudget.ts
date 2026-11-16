import { dbEnabled, query } from './db/pool.js';

// Monthly Gemini spend cap. Tokens are counted in Postgres (exact across containers); the rupee cost is an estimate
// from GEMINI_INR_PER_1M_INPUT / _OUTPUT. Without a database there is nothing to count and no cap.

const PERIOD_SQL = `date_trunc('month', now() AT TIME ZONE 'Asia/Kolkata')::date`;
const CACHE_MS = 60_000;
let cache: { at: number; value: boolean } | null = null;

const num = (name: string, def: number) => {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n >= 0 && process.env[name] !== undefined && process.env[name] !== '' ? n : def;
};

let lastGood: boolean | undefined; // the last value read successfully; undefined = none since startup
let lastWarn = 0;
/** One log line per 10 minutes per kind of failure, so a database outage cannot flood the log. */
function warnSometimes(msg: string, e: unknown) {
  if (Date.now() - lastWarn < 600_000) return;
  lastWarn = Date.now();
  console.error(`[ai-budget] ${msg}:`, e instanceof Error ? e.message : e);
}

/** Add one live Gemini call's tokens to this month's row. Never throws: a failed write must not fail a scan. */
export async function record(tokensIn: number, tokensOut: number): Promise<void> {
  if (!dbEnabled()) return;
  try {
    await query(
      `INSERT INTO ai_usage (period, calls, input_tokens, output_tokens) VALUES (${PERIOD_SQL}, 1, $1, $2)
       ON CONFLICT (period) DO UPDATE SET calls = ai_usage.calls + 1, input_tokens = ai_usage.input_tokens + $1, output_tokens = ai_usage.output_tokens + $2`,
      [Math.max(0, Math.round(tokensIn)), Math.max(0, Math.round(tokensOut))],
    );
  } catch (e) {
    warnSometimes('could not record usage (Gemini spend is going uncounted)', e);
  }
}

/**
 * True when this month's estimated Gemini cost has reached GEMINI_MONTHLY_BUDGET_INR (0 = no cap). Cached for 60 s.
 * When the database cannot be read: the last good value is kept; with none yet (cold start) a cap that cannot be
 * checked counts as reached, so the AI check pauses instead of spending without limit.
 */
export async function exhausted(): Promise<boolean> {
  const budget = num('GEMINI_MONTHLY_BUDGET_INR', 0);
  if (!dbEnabled() || budget <= 0) return false;
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.value;
  let value: boolean;
  let at = Date.now();
  try {
    const rows = await query<{ i: string; o: string }>(`SELECT input_tokens::text AS i, output_tokens::text AS o FROM ai_usage WHERE period = ${PERIOD_SQL}`);
    const cost = (Number(rows[0]?.i ?? 0) / 1e6) * num('GEMINI_INR_PER_1M_INPUT', 9) + (Number(rows[0]?.o ?? 0) / 1e6) * num('GEMINI_INR_PER_1M_OUTPUT', 36);
    value = lastGood = cost >= budget;
  } catch (e) {
    warnSometimes('could not read usage', e);
    value = lastGood ?? true; // fail closed on a cold start
    at -= CACHE_MS - 10_000; // look again in 10 s
  }
  cache = { at, value };
  return value;
}

export const resetBudgetCache = () => {
  cache = null;
  lastGood = undefined;
  lastWarn = 0;
};
