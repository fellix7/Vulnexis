# Testing Vulnera

Vulnera is tested with small offline self-checks for the risky logic, a type-check and build, and a manual end-to-end run before every demo.

## 1. Automated checks

Each check is a plain TypeScript file using `node:assert`, run with `tsx`. Checks marked *offline* need no network.

```bash
npx tsx server/src/pipeline/__checks__/parse.check.ts
```

| Check | Covers | Network |
| :--- | :--- | :--- |
| `parse.check.ts` | Lockfile parsing: scoped and nested packages, dev vs devOptional, dependency chains, dedupe, aliased installs, rejections, a 2,000-package performance case | offline |
| `score.check.ts` | Tier rules (KEV, EPSS threshold, severity, prod/dev, AI raise only), reasons, ordering | offline |
| `ai.check.ts` | Import detection, snippet building, secret redaction, citation validation, downgrade rules (a live Gemini part runs only when `GEMINI_API_KEY` is set) | offline |
| `github.check.ts` | GitHub link parsing (full URL, short form, `.git`, `/tree/<ref>`, rejects non-GitHub) and the in-memory tar reader (top folder stripped, paths over 100 characters, filter) | offline |
| `osv.check.ts` | OSV querybatch and advisory details against the live API | **live** |
| `enrich.check.ts` | EPSS and KEV enrichment against live data | **live** |

Run every check:

```bash
for f in server/src/pipeline/__checks__/*.check.ts; do npx tsx "$f" || echo "FAILED: $f"; done
```

The two live checks fail without internet access to `api.osv.dev` and `api.first.org`. That is expected in sandboxes.

Architecture context (offline, no network needed): `npx tsx server/src/pipeline/__checks__/context.check.ts` runs 23 cases: the kirana-billing demo (compose + OpenAPI + Markdown + auth mount), Kubernetes Ingress/ClusterIP/CronJob, serverless authorizers and schedules, Procfile with `dist/*.js → src/*.ts`, `vulnera.yml` vs compose conflicts, README-only claims, "not loaded" with a complete graph, dynamic `require` blocking that claim, transitive inheritance, open sign-up, lockfile-only scans, and the one-step / never-below-Plan / never-KEV policy.

## 1b. End-to-end smoke test

With the server running, `node demo/smoke-test.mjs` (add `--online` for a GitHub scan) drives the real API through the sample, the demo projects in `demo/projects/`, the bad inputs in `demo/bad-inputs/` and production routing, and prints PASS / FAIL / SKIP. See [demo/README.md](../demo/README.md).

## 2. Type-check, lint, build

```bash
npm run typecheck
```

```bash
npm run lint -w client
```

```bash
npm run build
```

## 3. API smoke test

With the server running (`OFFLINE=1` works for the sample):

```bash
curl -s localhost:8787/api/health
```

```bash
curl -sN -X POST localhost:8787/api/scan/stream -H 'content-type: application/json' -d '{"sample":true}' | head -5
```

Expected: health returns `{"ok":true,…}`; the stream prints `{"type":"step",…}` lines and ends with one `{"type":"result",…}`.

Bad input returns a clear error line:

```bash
curl -sN -X POST localhost:8787/api/scan/stream -H 'content-type: application/json' -d '{"repoUrl":"https://gitlab.com/a/b"}'
```

→ `{"type":"error","status":400,"error":"Only public github.com repositories are supported."}`

## 4. Manual end-to-end test plan (before every demo)

| # | Step | Expected |
| :--- | :--- | :--- |
| 1 | Open `/` on desktop and on a phone (390 px wide) | Hero, agent section, India section, pricing; no horizontal scroll |
| 2 | Toggle **हिंदी**, then back | Landing, nav and buttons switch; choice survives reload |
| 3 | `/scan` → tap **OWASP/NodeGoat** | Live timeline: fetch → plan → parse → OSV → EPSS·KEV → rank → Gemini → verify → report; each step has output, and decisions where relevant |
| 4 | Wait for the redirect to `/overview` | Funnel numbers; Fix-now list |
| 5 | Open a Fix-now finding | Reasons, advisory, chain, code evidence with file:line (if the key is set), verified fix |
| 6 | `/agent` | Same steps, tool list, sources cited, the five rules |
| 7 | `/india` | Verdict, summary, next steps, 4 obligations with working source links, plain-words list |
| 8 | **Share on WhatsApp** | WhatsApp (or web.whatsapp.com) opens with the summary; no number asked by Vulnera |
| 9 | Switch to हिंदी on `/india` | Verdict, summary, steps, obligations and plain words in Hindi; package names unchanged |
| 10 | `/remediation` → copy a command | Clipboard has the exact command |
| 11 | `/reports` → download Markdown and JSON | Files download; history lists the scan |
| 12 | Paste `https://github.com/expressjs/express` (no lockfile) | Clear error: "No package-lock.json found…", with Try again |
| 13 | Paste `not a link` | Inline hint; Run agent stays disabled |
| 14 | Stop the server and reload `/scan` | "API not reachable" banner, demo data still available |
| 15 | Start with `OFFLINE=1`, scan the sample | Works; offline banner shown; Gemini step skipped with a reason |
| 16 | Production build: `curl -i localhost:8787/assets/nope.js` | 404 (not the HTML page); `/india` still returns the app |
| 17 | Start with `MAX_CONCURRENT_SCANS=1`, start a scan, start a second at once | Second gets 429 "Vulnera is busy…"; works again after the first finishes |

## 5. Accessibility spot checks

- Tab through `/scan`: the GitHub field, Run agent, example chips, file pickers and Run scan are all reachable, with visible focus.
- With a screen reader, the live region announces the current agent step.
- With reduced motion enabled, timeline animations are off.
- Tier and risk colours always come with a word.

## 6. What is not covered yet

- No automated browser tests (Playwright is available in the dev environment; the flows in section 4 are the candidates).
- No load test for concurrent GitHub scans; see the limits in [ARCHITECTURE.md](ARCHITECTURE.md#8-expected-load-and-known-limits).
- India brief categorisation has no fixture test; changes to `client/src/lib/india.ts` should be checked on the sample scan by hand.
