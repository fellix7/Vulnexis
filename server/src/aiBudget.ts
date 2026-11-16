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
    console.error('[ai-budget] could not record usage:', e instanceof Error ? e.message : e);
  }
}

/** True when this month's estimated Gemini cost has reached GEMINI_MONTHLY_BUDGET_INR (0 = no cap). Cached for 60 s. */
export async function exhausted(): Promise<boolean> {
  const budget = num('GEMINI_MONTHLY_BUDGET_INR', 0);
  if (!dbEnabled() || budget <= 0) return false;
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.value;
  let value = false;
  try {
    const rows = await query<{ i: string; o: string }>(`SELECT input_tokens::text AS i, output_tokens::text AS o FROM ai_usage WHERE period = ${PERIOD_SQL}`);
    const cost = (Number(rows[0]?.i ?? 0) / 1e6) * num('GEMINI_INR_PER_1M_INPUT', 9) + (Number(rows[0]?.o ?? 0) / 1e6) * num('GEMINI_INR_PER_1M_OUTPUT', 36);
    value = cost >= budget;
  } catch (e) {
    console.error('[ai-budget] could not read usage:', e instanceof Error ? e.message : e);
    value = cache?.value ?? false; // fail open: a database blip should not switch the AI check off
  }
  cache = { at: Date.now(), value };
  return value;
}

export const resetBudgetCache = () => {
  cache = null;
};
