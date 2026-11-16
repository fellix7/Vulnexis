# Vulnera API reference

Base URL: the server origin (default `http://localhost:8787`). In development, the Vite dev server proxies `/api` to it.

All request bodies are JSON (≤ 10 MB). With accounts off (no `DATABASE_URL` or GitHub sign-in configured) there is no authentication and the API holds no user data. With accounts on, see [Accounts](#accounts-keys-quotas-and-saved-scans) below; the full design is in `ACCOUNTS_DESIGN.md`.

| Method | Path | Purpose |
| :--- | :--- | :--- |
| GET | `/api/health` | Server status and capabilities |
| GET | `/api/doctor` | Connection check: can the server reach OSV.dev, EPSS, npm, GitHub and Gemini (key validated); reason + advice for each blocked one |
| POST | `/api/scan/stream` | Run the agent and stream its steps (NDJSON) |
| POST | `/api/scan` | Run the agent and return the result in one response |
| GET | `/api/me`, GET `/auth/github`, POST `/api/auth/logout` | Sign-in and profile (accounts on; see ACCOUNTS_DESIGN.md) |
| GET, POST, DELETE | `/api/keys` | API keys (session only) |
| GET, DELETE, PUT | `/api/scans`, `/api/scans/:id`, `/api/scans/:id/review` | Saved scans (session or key) |
| POST, GET, DELETE | `/v1/scan`, `/v1/scan/stream`, `/v1/scans`, `/v1/scans/:id` | The same scan and history handlers, API key only |
| GET | `/*` | Production only: built client; paths without a file extension fall back to `index.html`, missing files (e.g. `/assets/old.js`) return 404 |

---

## GET /api/health

```json
{ "ok": true, "accounts": false, "offline": false, "gemini": true }
```

| Field | Meaning |
| :--- | :--- |
| `ok` | The server is up |
| `accounts` | Accounts are on (database + GitHub sign-in + public origin configured) |
| `offline` | `OFFLINE=1`: answers only from saved snapshots |
| `gemini` | A `GEMINI_API_KEY` is configured (the key itself is never returned) |

---

## Scan request body (both scan endpoints)

Exactly one input mode:

```jsonc
// 1. Public GitHub repository
{ "repoUrl": "https://github.com/OWASP/NodeGoat" }

// 2. Uploaded lockfile, optionally with source files for the AI code check
{ "lockfile": { /* package-lock.json contents */ }, "sources": [ { "path": "src/app.js", "content": "…" } ] }

// 2b. …plus architecture files for the exposure check (optional; read on the server, never sent to Gemini)
{ "lockfile": { }, "sources": [ ], "contextFiles": [ { "path": "docker-compose.yml", "content": "…" } ], "sourcesTruncated": false }

// 3. Bundled sample project (samples/demo-app)
{ "sample": true }

// Any mode: an optional label for the saved history (≤ 200 characters)
{ "repoUrl": "OWASP/NodeGoat", "meta": { "projectName": "NodeGoat" } }
```

Accepted `repoUrl` forms: `https://github.com/owner/repo`, `github.com/owner/repo`, `owner/repo`, a trailing `.git` or `/`, and `https://github.com/owner/repo/tree/<branch-or-tag>`.

---

## POST /api/scan/stream

Response: `200`, `Content-Type: application/x-ndjson; charset=utf-8`. One JSON object per line:

```jsonc
{"type":"step","step":{"id":"s1","tool":"github","title":"Reading the public GitHub repository","status":"running","startedAt":0,"input":"https://github.com/OWASP/NodeGoat","sources":[{"label":"GitHub (public repository)","url":"https://github.com"}]}}
{"type":"step","step":{"id":"s1","tool":"github","title":"Read OWASP/NodeGoat @ default branch","status":"done","startedAt":0,"ms":2140,"output":"package-lock.json + 44 source files (text only, nothing executed)", "...": "..."}}
{"type":"step","step":{"id":"s2","tool":"plan","title":"Planning the investigation","status":"running", "...": "..."}}
…
{"type":"result","result":{ /* ScanResult, with scanId when it was saved */ }}
```

- A step is sent twice: when it starts (`running`) and when it finishes (`done`, `skipped` or `failed`). Instant decision steps may arrive as `running` then `done` back to back. Clients should **replace steps by `id`**.
- While every scan slot is busy, the request waits in a fair queue and the server sends `{"type":"queue","position":2,"ahead":1}` whenever the position changes (`position` 1 = next). Steps follow once the scan starts.
- `{"type":"ping"}` is sent every 15 s when nothing else was, so proxies (nginx `proxy_read_timeout`, Cloudflare's 100 s) keep the connection open. Clients must ignore it.
- The stream ends with exactly one `result` or one `error` line:

```json
{"type":"error","status":400,"error":"No package-lock.json found in this repository. Vulnera needs an npm lockfile to know exact versions."}
```

Errors are sent in-band (the HTTP status stays 200 because headers are already sent); `status` is the equivalent HTTP status. The exceptions are `429` (rate limit, queue full, or too many scans from one client), which are returned as a normal JSON error before streaming starts.

If the client disconnects (or presses Cancel and aborts the fetch), the server stops the scan, or removes it from the queue, and frees the slot. A scan that runs longer than `SCAN_DEADLINE_MS` (default 180000, counted from when it gets a slot) is stopped with an in-band `{"type":"error","status":504,...}`.

### Reading the stream (browser)

```ts
const res = await fetch('/api/scan/stream', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ repoUrl }) })
const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader()
let buf = ''
for (;;) {
  const { value, done } = await reader.read()
  buf += value ?? ''
  let i
  while ((i = buf.indexOf('\n')) >= 0) {
    const msg = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1)
    if (msg.type === 'step') render(msg.step)
    if (msg.type === 'result') return msg.result
    if (msg.type === 'error') throw new Error(msg.error)
  }
  if (done) break
}
```

### Reading the stream (terminal)

```bash
curl -sN -X POST localhost:8787/api/scan/stream -H 'content-type: application/json' -d '{"sample":true}'
```

---

## POST /api/scan

Same body; responds once with `200` and a `ScanResult`, or an error status with `{ "error": "…" }`.

```bash
curl -s -X POST localhost:8787/api/scan -H 'content-type: application/json' -d '{"repoUrl":"OWASP/NodeGoat"}'
```

---

## ScanResult

```ts
interface ScanResult {
  scannedAt: string;            // ISO time
  packageCount: number;         // installed packages read from the lockfile
  findings: Finding[];          // sorted: tier, then EPSS, severity, name
  plans: UpgradePlan[];         // one per vulnerable name@version
  aiStatus: 'ok' | 'disabled' | 'error';
  notes: string[];              // non-fatal warnings (e.g. EPSS unreachable)
  agent?: AgentStep[];          // the agent's steps (see AGENT.md)
  repo?: { owner: string; name: string; ref: string; url: string; lockfilePath: string; sourceFiles: number;
          stars?: number; contributors?: number };   // from the GitHub API; left out if it is unreachable or rate limited (GITHUB_TOKEN raises the limit)
  scanId?: string;              // set when the scan was saved to the caller's history (signed-in or key callers; never for the sample)
  context?: {                   // architecture context (see ARCHITECTURE_CONTEXT.md)
    files: { path: string; kind: 'declaration' | 'compose' | 'kubernetes' | 'serverless' | 'procfile' | 'dockerfile' | 'openapi' | 'manifest' | 'markdown' }[];
    entryPoints: { component: string; file: string | null; exposure: Exposure; how: string; evidence: Evidence[] }[];
    protectedMounts: { file: string; line: number; prefix: string; guard: string }[];
    conflicts: string[];        // docs/config disagreements; the more exposed reading wins
    openSignup?: Evidence;      // a public sign-up route: login walls do not lower priority
    confident: boolean;         // import graph complete enough to claim "not loaded"
    reachedFiles: number;
  };
}

type Exposure = 'public' | 'unknown' | 'login' | 'internal' | 'offline' | 'unreached';
interface Evidence { file: string; line: number; quote: string }

interface Finding {
  pkg: { name: string; version: string; direct: boolean; dev: boolean; path: string[] };
  advisory: { id: string; aliases: string[]; summary: string; details: string;
              severity: 'CRITICAL' | 'HIGH' | 'MODERATE' | 'LOW' | 'UNKNOWN';
              fixedVersions: string[]; references: string[] };
  enrichment: { epss: number | null; kev: boolean | null };   // null = no data / no CVE
  tier: 'FIX_NOW' | 'FIX_SPRINT' | 'PLAN' | 'MONITOR';
  reasons: string[];
  ai?: { verdict: 'USES_VULNERABLE_API' | 'NO_VULNERABLE_USAGE_FOUND' | 'UNCERTAIN';
         reasoning: string;
         citations: { file: string; line: number; quote: string }[];   // verified against the file
         vulnerableApis?: string[] };
  exposure?: { level: Exposure; ssvc: 'open' | 'controlled' | 'small';
               vex?: 'vulnerable_code_not_in_execute_path';    // only for "unreached"
               via: string[]; reason: string; evidence: Evidence[];
               lowered: boolean;                                // moved down one step
               openSignup?: Evidence };
}

interface UpgradePlan {
  name: string; from: string;
  to: string | null;                       // null = no verified clean version
  jump: 'patch' | 'minor' | 'major' | null;
  command: string | null;                  // e.g. "npm install ejs@3.1.10" or "npm pkg set overrides.qs=6.10.3"
  viaParent?: string;                      // transitive: the direct dependency that pulls it in
}
```

The canonical definitions are in `server/src/types.ts` (copied to `client/src/types.ts`).

---

## Errors

| Status | When | Example message |
| :--- | :--- | :--- |
| 400 | Bad input: no lockfile / link / sample; unsupported or invalid lockfile; bad link; repository problems | "Unsupported lockfile: lockfileVersion 1 (npm 6 or older)…", "Only public github.com repositories are supported.", "This repository uses Yarn or pnpm…" |
| 400 | Repository too large | "This repository is larger than 60 MB…", "…too large to read (over 300 MB unpacked)…" |
| 404 | Sample missing on this server | "Sample project is not available on this server." |
| 502 | A data source failed (OSV, npm, GitHub unreachable) | "Scan failed while contacting a data source. Try again." |
| 429 | Queue full (`MAX_QUEUED_SCANS`); sent as a normal JSON error before the stream starts | "Vulnera is busy with other scans right now. Try again in a minute." |
| 429 | The client already has `MAX_SCANS_PER_CLIENT` scans running or queued | "You already have scans running. Wait for one to finish." |
| 429 | Rate limit (`SCAN_RATE_PER_MIN`, `SCAN_RATE_PER_DAY`; `/api/doctor` 10 per minute); has a `Retry-After` header in seconds | "Too many scans from this address. Try again in N minutes." |
| 400 | `key`, `api_key` or `token` in the query string (accounts on) | "Send API keys in the Authorization header, never in the URL." |
| 401 | Malformed, unknown or revoked API key | "This API key is not valid." |
| 401 | `/v1/*` without a key, `/api/scans` or `/api/keys` without a session | "Send an API key as ..." / "Sign in ..." |
| 401 | `code: "signin_required"`: an anonymous caller sent a lockfile (accounts on) | "Sign in to upload a lockfile." |
| 403 | A browser write to `/api/*` that is not same-origin (CSRF check) | |
| 404 | Saved scan not found, belongs to someone else, or the id is malformed | "Scan not found." |
| 409 | Creating an API key beyond the plan's `max_api_keys` | |
| 413 | Review larger than 64 KB; `meta.projectName` longer than 200 characters | |
| 429 | `code: "quota_exceeded"`: the plan's monthly scans (or the anonymous daily scans) are used up; the message says when it resets | "You have used all 30 scans on the Free plan this month. The quota resets on 1 December (IST)." |
| 429 | Too many failed API key lookups from one IP (`AUTH_FAIL_PER_MIN`) | "Too many failed attempts. Try again in a minute." |
| 504 | The scan passed `SCAN_DEADLINE_MS` | "This scan took longer than 3 minutes and was stopped. Try again, or upload the lockfile instead of a large repository." |
| 503 | Offline mode and no snapshot for this project | "Offline mode: this project has no saved snapshot…" |

All messages are safe to show to users as-is.

---

## Scan limits (environment variables)

| Variable | Default | Meaning |
| :--- | :--- | :--- |
| `MAX_CONCURRENT_SCANS` | 4 | Scans running at once |
| `MAX_QUEUED_SCANS` | 40 | Scans waiting for a slot; beyond this, 429 |
| `MAX_SCANS_PER_CLIENT` | 2 | Running + queued scans per client (IP, `TRUST_PROXY` aware) |
| `SCAN_DEADLINE_MS` | 180000 | Longest a scan may run once it has a slot |
| `SCAN_RATE_PER_MIN` | 6 | Scan requests per client per minute |
| `SCAN_RATE_PER_DAY` | 100 | Scan requests per client per day |

The queue and rate limiter live in one process; behind several instances, also limit at the proxy.

---

## Accounts, keys, quotas and saved scans

Active only when accounts are on (`/api/health` says `accounts: true`); otherwise these routes answer 404 (`/v1/*` answers 401) and scans behave as described above.

### Who is calling

1. `Authorization: Bearer vk_<16 hex>_<43 base64url>`: an API key. A malformed, unknown or revoked key is `401 {"error":"This API key is not valid."}` (it never falls back to the cookie). Keys are accepted **only** in this header; a `key`, `api_key` or `token` query parameter is `400`. Failed lookups are limited per IP.
2. The session cookie (`__Host-vulnera_sid`, or `vulnera_sid` on plain http) set by the GitHub sign-in.
3. Neither: anonymous.

Browser writes (non-GET `/api/*` with a cookie) must be same-origin; requests with a Bearer key skip that check. Responses about saved scans and keys send `Cache-Control: no-store`. A key never appears in logs and is shown once, when it is created.

### Scan route order and quotas

`POST /api/scan`, `POST /api/scan/stream` (and `/v1/...`, key only) run: identify, same-origin check, rate limit, **quota (before the body is read)**, body parser, validation, queue, scan, save, respond. An over-quota request is answered with 429 without reading its body.

| Caller | Allowed | Counted against |
| :--- | :--- | :--- |
| Signed in (session or key) | everything, body up to 10 MB | the plan's `monthly_scans` (month in IST); keys share the user's plan and are also tallied per key |
| Anonymous | `{sample:true}` or `{repoUrl}` only (body ≤ 4 KB); a lockfile is `401 signin_required` | the `anonymous` plan's `daily_scans` per IP (day in IST) |
| Anyone | the sample scan | nothing: never counted, never saved (a small `{sample:true}` is accepted even when the quota is used up) |

Headers on every admitted or refused scan request: `X-Quota-Limit`, `X-Quota-Remaining`. A scan is given back (refunded) when it fails validation, is a sample, is rejected by the queue, is cancelled while queued, or ends in an error (5xx, deadline, unreadable lockfile). It is kept once a result is delivered or once the client leaves after getting a slot. The queue's per-client limit is the plan's `max_concurrent`.

A saved scan comes back as `scanId` in the JSON result and in the stream's `result` message, and, for `POST /api/scan` and `/v1/scan`, as the `X-Scan-Id` header (a stream's headers are sent before the scan finishes, so it has none). If the scan was too big to store or storing failed, the result still arrives, with a note and no `scanId`.

The AI code check is skipped, with a note in `notes` and `aiStatus: "disabled"`, when the plan has `ai_enabled = false` or the month's Gemini budget is used up ("AI code check paused: this month's AI budget is used up. Priorities come from the published rules.").

### API keys

| Method | Path | Auth | Body / response |
| :--- | :--- | :--- | :--- |
| GET | `/api/keys` | session | `{ "keys": [{ "id", "name", "keyId", "last4", "createdAt", "lastUsedAt" }] }` (revoked keys left out) |
| POST | `/api/keys` | session | `{ "name": "ci" }` (1 to 60 characters) gives `201 { "key": {...}, "secret": "vk_..." }`. `409` at the plan's `max_api_keys`. |
| DELETE | `/api/keys/:id` | session | `{ "ok": true }`; `404` if unknown or already revoked |

### Saved scans

Scans are kept `SCAN_RETENTION_DAYS` (90) days. **Source code is never stored**: every code `quote` (AI citations and architecture evidence) is blanked before saving and the object gets `quoteStored: false`; `file` and `line` stay. The stored result is capped at 2 MB (agent steps are dropped first, then advisory details are shortened).

| Method | Path | Auth | Response |
| :--- | :--- | :--- | :--- |
| GET | `/api/scans?limit=20&cursor=` | session or key | `{ "scans": [{ "id", "source": "upload"\|"repo", "projectName", "packageCount", "findingCount", "fixNowCount", "aiStatus", "createdAt", "expiresAt" }], "nextCursor": string\|null }`. `limit` 1 to 50, newest first; pass `nextCursor` back as `cursor` (opaque; a bad one is 400). |
| GET | `/api/scans/:id` | session or key | the summary plus `result` (a ScanResult with `scanId`) and `review` |
| PUT | `/api/scans/:id/review` | session | `{ "review": {...} }` (≤ 64 KB, else 413) gives `{ "ok": true }` |
| DELETE | `/api/scans/:id` | session or key | `{ "ok": true }` |

Another user's scan, an expired one, and a malformed id are all `404`. The `/v1/scans` and `/v1/scans/:id` paths are the same handlers for API keys only (no review).

### `GET /api/me` shape (for reference)

`plan` is `{ id, name, monthlyScans, maxConcurrent, maxApiKeys, aiEnabled }`; `usage` is `{ period, scans, limit, resetsAt }` where `period` is the first day of the IST month (the day, for anonymous callers) as `YYYY-MM-DD`, `limit` is `null` when nothing limits the caller, and `resetsAt` is an ISO time.

### Accounts environment variables

| Variable | Default | Meaning |
| :--- | :--- | :--- |
| `DATABASE_URL` | unset | Postgres connection string; unset = accounts off |
| `MIGRATE_ON_START` | 1 | Run pending migrations before listening (the server exits with a clear log if they fail); 0 to run `npm run migrate -w server` yourself |
| `SCAN_RETENTION_DAYS` | 90 | How long saved scans are kept (an hourly sweep deletes expired scans, expired sessions and daily IP counters older than 2 days) |
| `AUTH_FAIL_PER_MIN` | 20 | Failed API key lookups per IP per minute before 429 |
| `GEMINI_MONTHLY_BUDGET_INR` | 0 | Monthly Gemini cap in rupees (0 = none); the AI step is skipped once the estimated spend reaches it (checked every 60 s, so a few scans in flight can overshoot) |
| `GEMINI_INR_PER_1M_INPUT`, `GEMINI_INR_PER_1M_OUTPUT` | 9, 36 | Rupee estimate per million tokens; confirm against current Gemini pricing |

Also used (read by the sign-in code): `DB_POOL_MAX`, `DATABASE_SSL`, `PUBLIC_ORIGIN`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `SESSION_TTL_DAYS`. See `ACCOUNTS_DESIGN.md` section 4.
