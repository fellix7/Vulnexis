# Accounts design: GitHub sign-in, sessions, API keys, quotas, saved scans

Design for Day 3 (planned with Fable at high effort, grounded in the code; the migration and the quota statement were run against local Postgres 16). Decisions: product name Vulnera; personal data is stored (email, GitHub id, scan results; source code never stored; scans kept 90 days; delete-my-account); GitHub sign-in only; payments via Razorpay later, so plans and quotas are data; a monthly Gemini budget cap. Anonymous use: the sample scan plus 2 public repo scans a day per IP; lockfile uploads need an account when accounts are on.

## 1. Data model

`server/migrations/001_init.sql` (applied by `server/src/db/migrate.ts`, at startup when `MIGRATE_ON_START` is not 0, or with `npm run migrate -w server`): `plans`, `users`, `sessions`, `api_keys`, `scans`, `usage`, `ai_usage`, all with row level security enabled and no policies (Supabase's REST API cannot read them; the app connects as owner). No `oauth_states` table: the OAuth state and PKCE verifier live in a 10-minute httpOnly cookie. No avatar column: the CSP (`img-src 'self' data:`) blocks GitHub avatars, so the UI shows an initial.

Already built (`server/src/db/`): `pool.ts` exports `dbEnabled()`, `getPool()`, `query<T>(sql, params)`, `tx(fn)`, `closeDb()`. `migrate.ts` exports `migrate(log?)`. `testdb.ts` exports `resetDb()` (refuses anything but a local `*_test`/`*_dev` database) and `makeUser(over?)`.

## 2. Auth

**Session cookie**: 32 random bytes, base64url, in `__Host-vulnera_sid` when `PUBLIC_ORIGIN` is https (`vulnera_sid` on plain http). `HttpOnly; SameSite=Lax; Path=/; Secure` (https). 30 days (`SESSION_TTL_DAYS`). Stored as sha256 in `sessions.id_hash`. Every login creates a new row (rotation); logout deletes it. `last_seen_at` updated at most every 10 minutes.

**API key**: `vk_<16 hex id>_<43 base64url chars>` (256 bits). Looked up by `key_id`, compared with `timingSafeEqual` on sha256. Accepted only as `Authorization: Bearer`. A `key` / `api_key` / `token` query parameter gets 400. Bearer wins over a cookie. Keys never appear in logs.

**CSRF** (`sameOrigin` middleware, on non-GET `/api/*` requests without a Bearer key): pass when `Sec-Fetch-Site: same-origin`, or `Origin` equals `PUBLIC_ORIGIN`; otherwise 403. A request carrying the session cookie with neither header is 403. Bodies must be `application/json` (existing parsers).

**GitHub OAuth** (own implementation): PKCE S256 plus `state`; scope `read:user user:email`; code exchanged server-side; primary verified email from `/user/emails`; the GitHub access token is used for those two calls and discarded, never stored.

| Route | Auth | Request → response | Codes |
|---|---|---|---|
| GET `/auth/github?returnTo=/path` | none | sets `vulnera_oauth` cookie (state, verifier, returnTo; Path=/auth; 10 min), 302 to GitHub | 302; 404 when accounts are off |
| GET `/auth/github/callback?code&state` | oauth cookie | compare state; exchange; fetch user + emails; upsert user by `github_id`; new session; 302 to `returnTo` (same-site path only, default `/overview`) | 302; failures 302 to `/scan?auth=denied\|state\|email\|error` |
| POST `/api/auth/logout` | session | `{}` → `{ok:true}`; deletes the row, clears the cookie | 200, 403 |
| GET `/api/me` | optional | `{accounts, user: null \| {id, login, name, email, createdAt}, plan: {id, name, monthlyScans, maxConcurrent, maxApiKeys, aiEnabled}, usage: {period, scans, limit, resetsAt}}` (anonymous: plan `anonymous`, daily usage) | 200 |
| DELETE `/api/me` | session | `{confirm: "<login>"}` → `{ok:true}`; `DELETE FROM users` cascades; cookie cleared | 200, 400, 401, 403 |
| GET `/api/keys` | session | `{keys: [{id, name, keyId, last4, createdAt, lastUsedAt}]}` (not revoked) | 200, 401 |
| POST `/api/keys` | session only | `{name}` → `{key: {...}, secret: "vk_..."}` (secret shown once) | 201, 400, 401, 409 at `max_api_keys` |
| DELETE `/api/keys/:id` | session | sets `revoked_at` → `{ok:true}` | 200, 404 |
| GET `/api/scans?limit=20&cursor=` | session or key | `{scans: [{id, source, projectName, packageCount, findingCount, fixNowCount, aiStatus, createdAt, expiresAt}], nextCursor}` (keyset on created_at, id) | 200, 401 |
| GET `/api/scans/:id` | session or key | summary + `result` + `review` | 200, 404 |
| PUT `/api/scans/:id/review` | session | `{review}` (max 64 KB) → `{ok:true}` | 200, 404, 413 |
| DELETE `/api/scans/:id` | session or key | `{ok:true}` | 200, 404 |
| `/v1/scan`, `/v1/scan/stream`, `/v1/scans`, `/v1/scans/:id` | key only | same handlers | + 401 |

Every scan query is `WHERE id = $1 AND user_id = $2`; a foreign or malformed id is 404. Signed-in responses send `Cache-Control: no-store`. `/api/health` adds `accounts: boolean`.

**Scan route order**: `identify` (caller: Bearer key, else session, else anonymous; a bad key is 401, failed lookups limited per IP) → `sameOrigin` → `scanLimiter` → `admit` (quota, before the body) → body parser → validate → queue → run → save → respond.
- Signed in: 10 MB parser as today. The sample scan is not counted or saved.
- Anonymous with accounts on: a 4 KB parser, so only `{sample:true}` or `{repoUrl}` fits; a lockfile gets 401 `{error, code: 'signin_required'}`. A repo scan consumes the daily IP counter.
- Save: strip citation `quote` text (source code is never stored), insert, return the id as `scanId` in the JSON result and in the stream's `result` message, plus an `X-Scan-Id` header. Over 2 MB: drop `agent` steps and trim advisory details; if it still fails, return the result with a note.
- `ScanRequest` gains optional `meta: {projectName}` (max 200 chars).

## 3. Quotas

One statement (`$1` subject, `$2` period, `$3` user id, `$4` plan limit, `$5` optional key subject):

```sql
WITH u AS (
  INSERT INTO usage (subject, period, user_id, scans) SELECT $1, $2, $3, 1 WHERE $4 > 0
  ON CONFLICT (subject, period) DO UPDATE SET scans = usage.scans + 1 WHERE usage.scans < $4
  RETURNING scans),
k AS (
  INSERT INTO usage (subject, period, user_id, scans) SELECT $5, $2, $3, 1 FROM u WHERE $5 IS NOT NULL
  ON CONFLICT (subject, period) DO UPDATE SET scans = usage.scans + 1)
SELECT scans FROM u;
```

No row = over quota: 429 `{error, code: 'quota_exceeded'}`; otherwise `X-Quota-Limit` and `X-Quota-Remaining` headers. Period: `date_trunc('month', now() AT TIME ZONE 'Asia/Kolkata')::date`. The user row enforces the limit (keys share the user's plan); the key row is for display. Refund (`scans - 1 WHERE scans > 0`) on validation failure, sample, queue rejection, cancel while queued, any 5xx or timeout; no refund once a result is delivered or the client leaves after getting a slot.

`clientKey(req)` returns `key:<id>`, `user:<id>` or the IP for the rate limiter; the queue uses `user:<id>` when known, with a per-call cap from `plan.max_concurrent`.

**Gemini budget**: `aiBudget.exhausted()` compares this month's `ai_usage` tokens times the configured rupee rates with `GEMINI_MONTHLY_BUDGET_INR` (60 s cache). `runScan` checks it together with `plan.ai_enabled` when deciding whether to run the AI step; when exhausted the step is skipped, `aiStatus` stays `'disabled'`, and a note says "AI code check paused: this month's AI budget is used up. Priorities come from the published rules." `ai.ts` records tokens after each live call. Overshoot is at most 20 calls per running scan.

**Sweep** (hourly): expired scans and sessions; IP usage rows older than 2 days.

## 4. Configuration

| Variable | Default | Notes |
|---|---|---|
| `DATABASE_URL` | unset | unset: accounts off |
| `DATABASE_SSL` | on unless the host is local | |
| `DB_POOL_MAX` | 5 | per container |
| `MIGRATE_ON_START` | 1 | |
| `PUBLIC_ORIGIN` | `http://localhost:5173` in development | required in production |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | unset | unset: accounts off |
| `SESSION_TTL_DAYS` | 30 | |
| `SCAN_RETENTION_DAYS` | 90 | |
| `AUTH_FAIL_PER_MIN` | 20 | per IP |
| `GEMINI_MONTHLY_BUDGET_INR` | 0 (no cap) | |
| `GEMINI_INR_PER_1M_INPUT`, `GEMINI_INR_PER_1M_OUTPUT` | 9, 36 | estimates: confirm against current pricing |
| `GITHUB_OAUTH_URL`, `GITHUB_API_URL` | GitHub | tests only; ignored in production |

`accountsEnabled()` = database + both GitHub values + an origin. When off, the app behaves exactly as before (uploads allowed, own-machine bypass kept), auth routes 404, and the UI hides sign-in.

## 5. Client

- `client/src/state/auth.tsx`: `AuthProvider` + `useAuth()` → `{accounts, user, plan, usage, signIn(returnTo), signOut(), refresh()}`; `signIn` navigates to `/auth/github`.
- AppShell and LandingNav: "Sign in with GitHub", or a user chip (initial + login) with Account and Sign out; a quota line ("3 of 30 scans this month") in the sidebar footer.
- `/account`: profile, plan and usage, API keys (create, show once with copy, revoke), danger zone (type the login to delete the account).
- History when signed in: server summaries, full records loaded on demand (`loadScan(id)`, memory cache); Compare loads two; review changes debounced to the PUT; stored scans show "quote not stored" in Code evidence.
- Scan page: anonymous upload shows a sign-in prompt; quota errors shown by `code`.
- Logout: remove every `vulnera:*` localStorage key except the language, reset memory state. Signed-in history never touches localStorage.
- `api.ts`: `fetchMe`, `logout`, `deleteAccount`, `listKeys`, `createKey`, `revokeKey`, `listScans`, `getScan`, `deleteScan`, `putReview`; scan functions return `scanId`.

## 6. Interfaces between modules

- `server/src/db/pool.ts`, `server/src/db/testdb.ts`: see section 1.
- `server/src/quota.ts`: `planAndUsage(userId | null, ip): Promise<{plan, usage}>`.
- `server/src/auth/config.ts`: `accountsEnabled()`, `publicOrigin()`.
- `server/src/auth/session.ts`: `sessionUser(req): Promise<{id, login, name, email, planId} | null>`, `requireSession: RequestHandler` (sets `res.locals.user`), `createSession(res, userId)`, `destroySession(req, res)`.
- `server/src/auth/csrf.ts`: `sameOrigin: RequestHandler`.
- `server/src/auth/routes.ts`: `authRouter(): Router` with both `/auth/*` routes, logout and `/api/me`.

## 7. Risks

1. Code quotes from the AI check are stripped from stored scans, so "source code is never stored" stays true; they are shown only during the live scan.
2. `TRUST_PROXY` must equal the real number of proxies (Cloudflare + host), or all anonymous users share one IP quota.
3. Supabase: use the session pooler (port 5432, IPv4), not the transaction pooler (6543), which breaks advisory locks.
4. The rate limiter and queue stay per process: two containers double burst and concurrency limits. Monthly quotas and the AI budget are in Postgres and exact.
5. IP usage rows hold an unsalted daily hash, deleted after 2 days: mention it in the privacy policy.
6. Real GitHub sign-in cannot be tested in the sandbox. Create the OAuth app with callback `${PUBLIC_ORIGIN}/auth/github/callback` and test once on staging.
