<div align="center">

<img src="https://capsule-render.vercel.app/api?type=rect&height=200&color=0:09090B,50:14210A,100:0B1F12&text=VULNERA&fontSize=72&fontColor=FFFFFF&fontAlignY=42&desc=AI%20SECURITY%20AGENT%20FOR%20SMALL%20TEAMS&descSize=15&descAlignY=64&animation=fadeIn&stroke=C6F432&strokeWidth=1" width="100%" alt="Vulnera: AI security agent for small teams"/>

### Paste a GitHub link. Get a verified fix order in minutes.

**Infra Shift Hackathon 2026** · ML.ai × Infrasity × Geek Room · **Problem Statement 3: Open Innovation**

</div>

---

## The problem, in one paragraph

Indian student teams, two-person startups and small agencies ship Node.js apps that pull in hundreds of open-source packages. Most have no security person. `npm audit` gives them a wall of 70+ alerts in English security jargon, with no idea which ones matter. Meanwhile the **DPDP Act 2023** makes them responsible for "reasonable security safeguards" (Section 8(5), penalties up to ₹250 crore), and **CERT-In's 2022 directions** require reporting attacks within 6 hours. The founder, often non-technical, needs a decision; the developer needs a command.

## What Vulnera does

**Target user:** a developer at an Indian startup or agency with no security team, and the founder or client they answer to.

**Outcome:** in about a minute, a short ranked fix list with evidence, verified upgrade commands, and a Markdown or JSON report to share.

1. **Real input:** paste a public GitHub link (works from a phone browser) or upload `package-lock.json`. No login needed.
2. **The agent plans** which tools this run needs, and **streams every step live**: tool, input, output, **decision**, and the **source** behind it.
3. **Calls tools:** OSV.dev (facts), FIRST EPSS + CISA KEV (real-world exploitation), npm registry (versions), Gemini (reads your code).
4. **Decides:** ranks with fixed, published rules; Gemini can only *raise* a priority when it finds your code calling the vulnerable function, and every code citation is re-checked against the real file.
5. **Verifies the fix:** re-queries each upgrade target so a fix never lands on another vulnerable version. If there is no clean version, it says so.
6. **Reports:** the fix order with exact `npm` commands, exported as Markdown or JSON, with history and side-by-side compare.

**Honesty rules the agent cannot break:** facts come only from OSV.dev; AI never adds or removes a vulnerability; "not found" is shown as "needs review", never "safe"; when unsure it says "uncertain"; it gives information, not legal advice.

## Try it (judges)

| Path | What to look at |
| :--- | :--- |
| `/scan` → tap **OWASP/NodeGoat** | The agent working live, step by step |
| `/agent` | Full trace: tools used, decisions, sources cited |
| `/overview` → `/findings` → any finding | Why it was ranked, code evidence, verified fix |
| `/remediation` | Exact `npm` commands, verified vs not |
| `/reports` | Markdown / JSON export, history, compare two scans |

No network? **Scan the bundled sample** or **Explore demo data** on `/scan`.

**Test it on your own machine:** [`demo/`](demo/README.md) has one-command start scripts (`./demo/start.sh`, `.\demo\start.ps1`), a deliberately vulnerable Indian billing app and a clean app to upload, bad inputs, an automated smoke test (`node demo/smoke-test.mjs`) and a click-through checklist.

## How it maps to the judging criteria

| Criterion | Where it shows |
| :--- | :--- |
| **Technical implementation (20)** | TypeScript monorepo; streaming NDJSON agent protocol; tarball reader for GitHub repos (no API quota); batched OSV queries; OSV re-verification of every upgrade; citation validation; offline snapshot mode; single-process production build |
| **ML.ai implementation (10)** | See [docs/PITCH.md](docs/PITCH.md#mlai), which records how the team used the ML.ai coding agent during the build |
| **Innovation & originality (10)** | Code-reachability check (does *your* code call the vulnerable function?) + architecture-aware exposure (internet-facing or internal) + verified upgrades that never land on another vulnerable version |
| **User experience & design (10)** | Phone-first GitHub-link flow; live agent timeline; dark UI with colour always paired with a label |
| **Completeness & functionality (10)** | End-to-end: input → plan → tools → decisions → verified fix → export (Markdown/JSON) → history/compare |
| **Presentation & demo (10)** | 3-minute script in [docs/PITCH.md](docs/PITCH.md) |

## Business case

| | |
| :--- | :--- |
| **Who pays** | Indian seed-stage startups (₹999/month) and dev agencies maintaining client apps (₹4,999/month, 25 projects, white-label report). Free for students and open source |
| **What they renew for** | Weekly re-scan + an alert the day a package they use appears on the exploited list |
| **First 100 users** | College tech clubs and hackathons (free tier + "Scanned by Vulnera" README badge), helpful PRs to popular Indian OSS repos, one free client report for agencies on LinkedIn |

## Architecture

```
Phone / browser (React 19 + Vite)
   │  POST /api/scan/stream   { repoUrl } | { lockfile, sources? } | { sample: true }
   ▼  ← NDJSON: {type:"step"} … {type:"result"}
Express + TypeScript agent                         server/src/index.ts, agent.ts
   0. fetch    public GitHub tarball (text only)   pipeline/github.ts
   1. plan     choose tools from inputs/capabilities
   2. parse    package-lock.json → packages        pipeline/parse.ts
   3. osv      exact version match (batched)       pipeline/osv.ts, match.ts
   4. enrich   FIRST EPSS + CISA KEV               pipeline/enrich.ts
   5. rank     fixed, published tier rules          pipeline/score.ts
   6. gemini   code-usage verdicts + citation check pipeline/ai.ts
   7. verify   smallest clean upgrade, re-checked   pipeline/plan.ts
   8. report   fix order + exact commands (Markdown / JSON export)
```

The original pipeline is unchanged; Vulnera wraps it in an agent that records and streams each step.

## Run it

```bash
npm ci
```

(`npm ci` installs the exact versions in `package-lock.json` without rewriting it, so `git pull` never conflicts on the lockfile.)

```bash
cp .env.example .env
```

Add `GEMINI_API_KEY` to `.env` (free key: https://aistudio.google.com/apikey). Then:

```bash
npm run dev
```

API on `http://localhost:8787`, app on `http://localhost:5173`. For a single production process:

```bash
npm run build && npm start
```

`OFFLINE=1` serves OSV/EPSS answers from `data/snapshots` (the bundled sample works without network).

## Host it (one container)

```bash
docker build -t vulnera .
```

```bash
docker run -p 8080:8080 -e TRUST_PROXY=1 -e GEMINI_API_KEY=your-key vulnera
```

Ready-made configs: [`fly.toml`](fly.toml) (Fly.io, Mumbai) and [`render.yaml`](render.yaml) (Render). Step by step: [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md#5-host-it-for-demos).

## Limits (said plainly)

* npm `package-lock.json` only (no Yarn/pnpm yet); public GitHub repos only.
* The code check reviews the top 30 direct-dependency findings; others show "Not assessed".
* Missing code evidence does not prove a vulnerability is unreachable.

## Security by design

| Principle | Implementation |
| :--- | :--- |
| No project execution | Repos and uploads are read as text, never installed or run |
| Minimal personal data | No login needed to scan; optional GitHub sign-in stores only your GitHub id, login and email. Nothing like Aadhaar, PAN, OTP or bank details is ever asked |
| Minimal AI context | Only line windows around imports and uses of vulnerable packages reach Gemini (never whole files), with obvious secrets masked (best effort). Nothing is stored on disk; AI answers stay in server memory for up to 24 h. Use a paid Gemini tier for customer code and check Google's current terms |
| Server-side secrets | The Gemini key never leaves the server |
| Cited facts | Every step links its data source; every code citation is machine-verified |

---

<div align="center">

Built on the team's Vulnera pipeline (Tech Yuva × GDG Gurugram Build-a-thon 2026), extended into a security agent.

</div>
