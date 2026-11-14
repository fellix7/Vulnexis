# Vulnexis API reference

Base URL: the server origin (default `http://localhost:8787`). In development, the Vite dev server proxies `/api` to it.

All request bodies are JSON (≤ 10 MB). There is no authentication: the API holds no user data.

| Method | Path | Purpose |
| :--- | :--- | :--- |
| GET | `/api/health` | Server status and capabilities |
| GET | `/api/doctor` | Connection check: can the server reach OSV.dev, EPSS, npm, GitHub and Gemini (key validated); reason + advice for each blocked one |
| POST | `/api/scan/stream` | Run the agent and stream its steps (NDJSON) |
| POST | `/api/scan` | Run the agent and return the result in one response |
| GET | `/*` | Production only: built client; paths without a file extension fall back to `index.html`, missing files (e.g. `/assets/old.js`) return 404 |

---

## GET /api/health

```json
{ "ok": true, "offline": false, "gemini": true }
```

| Field | Meaning |
| :--- | :--- |
| `ok` | The server is up |
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
{"type":"result","result":{ /* ScanResult */ }}
```

- A step is sent twice: when it starts (`running`) and when it finishes (`done`, `skipped` or `failed`). Instant decision steps may arrive as `running` then `done` back to back. Clients should **replace steps by `id`**.
- The stream ends with exactly one `result` or one `error` line:

```json
{"type":"error","status":400,"error":"No package-lock.json found in this repository. Vulnexis needs an npm lockfile to know exact versions."}
```

Errors are sent in-band (the HTTP status stays 200 because headers are already sent); `status` is the equivalent HTTP status. The one exception is `429` (server busy), which is returned as a normal JSON error before streaming starts.

If the client disconnects, the server stops the scan before its next step and frees the slot.

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
  context?: {                   // architecture context (see ARCHITECTURE_CONTEXT.md)
    files: { path: string; kind: 'vulnexis' | 'compose' | 'kubernetes' | 'serverless' | 'procfile' | 'dockerfile' | 'openapi' | 'manifest' | 'markdown' }[];
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
| 429 | Too many scans running at once on this server (`MAX_CONCURRENT_SCANS`, default 4); sent as a normal JSON error before the stream starts | "Vulnexis is busy with other scans right now. Try again in a minute." |
| 503 | Offline mode and no snapshot for this project | "Offline mode: this project has no saved snapshot…" |

All messages are safe to show to users as-is.
