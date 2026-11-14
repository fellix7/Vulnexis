# Kavach architecture

Kavach is one TypeScript project in npm workspaces: an Express API (`server/`) that runs the scan agent, and a React + Vite single-page app (`client/`). There is no database. In production, the API also serves the built client, so it deploys as one Node process.

```
┌──────────────────────────── Browser (phone or desktop) ────────────────────────────┐
│ React 19 SPA · EN | हिंदी · history in localStorage                                │
│  /  /scan  /overview  /agent  /india  /findings  /finding  /evidence  /remediation  /reports │
└───────────────┬───────────────────────────────────────────────▲────────────────────┘
                │ POST /api/scan/stream  (JSON body)            │ NDJSON lines:
                │ { repoUrl } | { lockfile, sources? } | { sample } │ {type:"step"} … {type:"result"|"error"}
┌───────────────▼───────────────────────────────────────────────┴────────────────────┐
│ Express 5 (server/src/index.ts)                                                     │
│  scan(req, onStep) ── Agent (server/src/agent.ts) records + streams every step      │
│                                                                                     │
│  fetch ─► plan ─► parse ─► osv ─► enrich ─► rank ─► gemini ─► (re-rank) ─► verify ─► report │
│  github.ts       parse.ts  osv.ts  enrich.ts score.ts ai.ts               plan.ts    │
│                            match.ts                                                 │
│  cache.ts: data/snapshots (committed) → .cache (local) → network                    │
└───────┬───────────┬───────────┬───────────┬───────────┬───────────┬─────────────────┘
        ▼           ▼           ▼           ▼           ▼           ▼
   codeload     OSV.dev     FIRST EPSS   CISA KEV    npm registry   Gemini
   (GitHub)                              (data/kev.json)
```

## 1. Repository layout

```
.
├── client/                      React + Vite app
│   ├── src/App.tsx              routes, LangProvider, ScanProvider
│   ├── src/api.ts               fetchHealth, postScan, streamScan (NDJSON reader)
│   ├── src/router.tsx           tiny History-API router
│   ├── src/state/store.tsx      current scan, live agent steps, history (localStorage)
│   ├── src/lib/i18n.tsx         EN/HI context, tr(en, hi), LangToggle
│   ├── src/lib/india.ts         India brief: risk categories, CERT-In/DPDP mapping, WhatsApp text
│   ├── src/lib/*.ts             selectors, tiers, review, report export, funnel …
│   ├── src/components/agent/    AgentTimeline, AgentLive (+ agent.css)
│   ├── src/components/scan/     RepoInput, LockfileDrop, SourceFolder, ScanSide
│   ├── src/components/landing/  Hero, Bharat (agent loop, India, pricing), …
│   ├── src/pages/               Landing, Scan, Overview, Agent, India, Findings, …
│   └── src/mock.ts              labelled demo data (incl. an illustrative agent trace)
├── server/
│   └── src/
│       ├── index.ts             Express app, scan() orchestration, /api routes, static client
│       ├── agent.ts             Agent step recorder + source catalogue
│       ├── types.ts             shared shapes (copied to client/src/types.ts)
│       ├── cache.ts             snapshot / local cache / fetch, OFFLINE mode
│       ├── keys.ts              finding key helper
│       └── pipeline/
│           ├── github.ts        link parser, codeload download, in-memory tar reader
│           ├── parse.ts         package-lock.json v2/v3 → packages
│           ├── osv.ts, match.ts OSV querybatch + advisory details
│           ├── enrich.ts        EPSS + KEV
│           ├── score.ts         fixed tier rules + reasons
│           ├── ai.ts            Gemini code check, redaction, citation validation
│           ├── plan.ts          smallest verified upgrade per package
│           └── __checks__/      offline self-checks (run with tsx)
├── data/
│   ├── kev.json                 CISA KEV snapshot
│   └── snapshots/               saved API answers for OFFLINE=1
├── samples/demo-app/            QuickNotes: deliberately outdated Express app
└── docs/                        this documentation
```

## 2. Request lifecycle

1. **Client** (`pages/Scan.tsx`) builds a `ScanRequest` and calls `runScan` in the store.
2. **Store** (`state/store.tsx`) calls `streamScan`, appending or replacing each streamed step in `liveSteps` (keyed by step id). The scan page renders `AgentLive` from `liveSteps`.
3. **Server** `POST /api/scan/stream` sets `Content-Type: application/x-ndjson`, flushes headers, and calls `scan(body, onStep)`.
4. `scan()` creates an `Agent` whose `onChange` writes each step as one JSON line. Steps are emitted on start (`running`) and on finish (`done` / `skipped` / `failed`).
5. When the pipeline finishes, the server writes `{type:"result", result}` and ends the response. Errors become `{type:"error", status, error}`.
6. The client stores the result as a `ScanRecord` (history, last 8, in `localStorage`) and navigates to `/overview`.
7. Pages derive everything else from the stored result: the funnel, tiers, the India brief (`buildIndiaBrief`), exports.

`POST /api/scan` remains as a one-shot JSON endpoint with the same `scan()` underneath. The client falls back to it if the streaming route returns 404.

## 3. Pipeline stages

| Stage | Module | What it does | External calls |
| :--- | :--- | :--- | :--- |
| fetch | `pipeline/github.ts` | Parse link → download `codeload.github.com/<owner>/<repo>/tar.gz/<ref>` → gunzip (≤ 300 MB) → read tar in memory → pick shallowest lockfile → collect JS/TS sources next to it | codeload (1 request) |
| plan | `index.ts` | Decide tools from inputs (lockfile, sources) and capabilities (Gemini key, offline snapshots) | none |
| parse | `pipeline/parse.ts` | lockfile v2/v3 `packages` map → `{name, version, direct, dev, path[]}` with dependency chains | none |
| osv | `pipeline/osv.ts`, `match.ts` | Batched `querybatch` (500 per call), then advisory details (8 in parallel); severity from CVSS; fixed versions per range | OSV.dev |
| enrich | `pipeline/enrich.ts` | EPSS for CVE aliases (50 per call); KEV membership from `data/kev.json` | FIRST, (CISA) |
| rank | `pipeline/score.ts` | Fixed tier rules + human-readable reasons; sorted by tier, EPSS, severity | none |
| gemini | `pipeline/ai.ts` | Top 30 direct findings grouped by package; locate imports; build masked snippets; one call per ≤ 12 advisories; validate citations | Gemini |
| re-rank | `pipeline/score.ts` | Rescore with verdicts (AI can only raise) | none |
| verify | `pipeline/plan.ts` | Candidate = max of the next fixed version per advisory; re-query OSV for the candidate; if still vulnerable, try the next 5 stable releases from npm; build the command | OSV.dev, npm |
| report | `index.ts` | Summary step; result assembled | none |

## 4. The agent layer

`server/src/agent.ts` is a small recorder, not a framework:

- `start(tool, title, patch)` → pushes a `running` step and emits it.
- `finish(step, status, patch)` → sets status, duration and final fields, emits again.
- `note(tool, title, patch)` → an instant decision step.
- `run(tool, title, patch, fn, after)` → wraps a tool call: emits start, runs `fn`, emits `done` with `after(value)` fields, or `failed` with the error message (and rethrows).

The pipeline modules are unchanged from the original Vulnera build; the agent wraps them, which keeps the architecture intact. See [AGENT.md](AGENT.md) for the decision rules.

## 5. Caching and offline mode

`cache.ts` looks up `data/snapshots/<namespace>/<hash>.json`, then `.cache/<namespace>/<hash>.json`, then the network.

- Lockfile-dependent namespaces (`osv-query`, `osv-vuln`, `epss`, `npm-registry`) are always fetched live unless `OFFLINE=1`, so results stay current.
- Every live answer is written to `.cache/` so it can be promoted into `data/snapshots/` for an offline demo.
- `OFFLINE=1`: only saved answers are used; a miss raises `OfflineMissError`, which the API turns into a clear 503 message.
- Gemini answers are cached by a hash of prompt version, package, advisory ids and code. Offline mode uses the code check only if `data/snapshots/gemini-package/` exists.

## 6. Client architecture

- **Routing:** `router.tsx`, a History-API router (no dependency). Unknown paths render a 404 inside the app shell.
- **State:** one React context (`ScanProvider`) holds the current scan, status, error, `liveSteps`, history, health and in-memory sources. History is written to `localStorage`, and the oldest entries are dropped if the quota is exceeded.
- **Language:** `LangProvider` exposes `tr(en, hi)`. Strings sit next to the component that shows them, which avoids a dictionary drifting out of sync. `<html lang>` follows the choice; Devanagari uses Noto Sans Devanagari (self-hosted via Fontsource).
- **India brief:** `lib/india.ts` is a pure function of the scan result and human review, so it works for live scans, history and demo data alike. See [INDIA_COMPLIANCE.md](INDIA_COMPLIANCE.md).
- **Design system:** tokens in `index.css` (dark-first, accent `#c6f432`, semantic colours always paired with labels; AI content is violet and dashed). Each page has its own CSS file. See [DESIGN.md](DESIGN.md).

## 7. Production topology

```
npm run build   →  server/dist (tsc) + client/dist (vite)
npm start       →  node server/dist/index.js
                   ├── /api/*            JSON + NDJSON
                   ├── static client/dist (1 h cache)
                   └── SPA fallback: any other GET → index.html
```

One process, one port (`PORT`, default 8787). Put a reverse proxy in front for TLS, and turn off proxy buffering for `/api/scan/stream` (the server already sends `X-Accel-Buffering: no` and `Cache-Control: no-transform`). See [DEPLOYMENT.md](DEPLOYMENT.md).

## 8. Expected load and known limits

Designed for a hackathon demo and a small public deployment (tens of concurrent users).

- Each GitHub scan holds the compressed (≤ 60 MB) and unpacked (≤ 300 MB) tarball in memory while it runs, so each process runs at most `MAX_CONCURRENT_SCANS` (default 4) scans at once and answers 429 beyond that. The counter is per process: behind several instances, add proxy rate limiting.
- If the browser disconnects mid-stream, the agent stops before its next step (an `AbortSignal` checked in `Agent.start`), and the slot is freed.
- In production, only extensionless paths fall back to `index.html`; a missing asset returns 404 so stale tabs do not load HTML as JavaScript.
- The Gemini step is rate limited per process (`GEMINI_RPM`); several instances do not share that budget.
- History is per browser; there is no cross-device sync by design (no personal data on the server).
