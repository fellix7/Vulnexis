# Vulnera MVP: what we present

> **Note (after the hackathon):** the India brief (`/india`), the Hindi toggle and WhatsApp sharing described here have been removed from the product. This document is kept as the hackathon record.

> **Vulnera** is an AI security agent for India's builders. Paste a GitHub link, and the agent finds which vulnerable open-source packages to fix first, checks whether your code really uses them, verifies the safest upgrade, and explains it in Hindi or English, mapped to CERT-In and the DPDP Act.

**Event:** Infra Shift Hackathon 2026 (ML.ai × Infrasity × Geek Room), 14 November 2026, 4 to 5 hour build window
**Track:** Problem Statement 3, Open Innovation: *"Build an AI agent that solves a real problem for India and Indians"*
**Scoring:** out of 70 (Technical 20 · ML.ai 10 · Innovation 10 · UX 10 · Completeness 10 · Presentation 10)

Related documents: [Demo script](PITCH.md) · [System policies](SYSTEM_POLICIES.md) · [Architecture](ARCHITECTURE.md) · [Agent design](AGENT.md) · [India compliance logic](INDIA_COMPLIANCE.md) · [API](API.md) · [User guide](USER_GUIDE.md) · [Deployment](DEPLOYMENT.md) · [Testing](TESTING.md)

---

## 1. Product explanation (the one-minute version)

| | |
| :--- | :--- |
| **Who it is for** | Developers at Indian startups, student teams and small agencies who ship Node.js apps but have **no security person**, and the **non-technical founder or client** they report to. |
| **The problem** | A normal app pulls in hundreds of open-source packages. `npm audit` returns a wall of alerts (76 on our sample app) in English security jargon, with no order. Teams either ignore all of it or lose a day reading advisories. Since the **DPDP Act 2023** (Section 8(5): "reasonable security safeguards", penalties up to ₹250 crore) and **CERT-In's 2022 directions** (report incidents within 6 hours), "we did not know" is no longer a safe answer. |
| **Why it is worth solving** | Fixing the right three packages beats reading seventy advisories. The founder needs a decision in their language; the developer needs an exact command. Nothing on the market gives both, with Indian rules attached. |
| **Intended outcome** | In about a minute: a short ranked fix list with evidence, verified upgrade commands, an India brief (CERT-In / DPDP), and a plain Hindi or English summary they can send on WhatsApp. |
| **Where its limits are** | npm `package-lock.json` only; public GitHub repos only (or upload); the code check covers the top 30 direct-dependency findings; information, not legal advice. |

---

## 2. How the MVP meets every PS3 requirement

### Core MVP requirements

| PS3 requirement | Vulnera | Where to see it |
| :--- | :--- | :--- |
| Define the target user, problem and outcome | Section 1 above, the landing page ("Built for India"), README | `/`, `#india` |
| One complete end-to-end workflow | GitHub link → plan → tools → decisions → verified fix → India brief → WhatsApp / export | `/scan` → `/overview` → `/india` |
| Agent takes real steps (reads a source, calls a tool, decides) with **reasoning visible** | Every step streams live with tool, input, output, **decision**, source link; full trace page | `/scan` (live), `/agent` |
| Usable interface in a phone browser, Hindi or English, an example judges can test | GitHub-link flow needs no files; EN / हिंदी toggle; two one-tap example repos | `/scan` on a phone |
| No sensitive personal data; show the source for any fact | No login or forms; every step and every finding links its source (OSV, EPSS, CISA KEV, CERT-In, MeitY) | Everywhere; see [policies](SYSTEM_POLICIES.md#2-personal-data-policy) |

### Goals

| Goal | How |
| :--- | :--- |
| **Choose an Indian problem** | Security triage plus DPDP / CERT-In exposure for India's startups and agencies |
| **Act as an agent** | Plans from its inputs and capabilities, calls 6 tools, decides at each step (skip the code check when there is no code; send exploited bugs straight to Fix now; refuse an unverified upgrade), shows all of it |
| **Build a working solution** | Real data from OSV.dev, FIRST EPSS, CISA KEV, npm and Gemini; no mock in the live path |
| **Design for India** | Hindi and English, Devanagari font, WhatsApp share, works without file upload on a phone, Indian law mapped |
| **Stay safe and honest** | Asks for no personal data; cites sources; says "uncertain" or "not assessed" instead of guessing; AI cannot add, remove or lower a finding |

### Advanced capabilities shipped (optional in PS3)

| Capability | Status |
| :--- | :--- |
| Integrations with public open data | OSV.dev, FIRST EPSS, CISA KEV, npm registry, GitHub |
| Evaluation of the agent's answers | Every AI code citation is machine-checked against the real file; uncited "uses" verdicts are downgraded |
| Persistent memory | Scan history and before/after comparison (in the browser, no server storage) |
| Delivery through WhatsApp | One-tap WhatsApp share of the bilingual summary (`wa.me` link, no API, no number collected) |
| Offline-friendly design | `OFFLINE=1` serves saved snapshots; the bundled sample and demo data always work |
| Multi-agent / voice | Not built (out of scope for the build window) |

---

## 3. The end-to-end journey (what judges will watch)

```
 ① Input            ② Plan               ③ Tools                    ④ Decide              ⑤ Answer
 GitHub link   →    which tools?    →    OSV · EPSS · KEV ·     →   rank, raise,     →   fix list · commands ·
 (or lockfile)      why?                 Gemini · npm               verify, refuse        India brief · हिंदी · WhatsApp
```

1. **Input.** On `/scan`, paste `https://github.com/owner/repo` or tap **OWASP/NodeGoat**. The server downloads the repo once as a tarball and reads it as text: `package-lock.json` plus up to 120 JS/TS files (3 MB). Nothing is installed or run.
2. **Plan.** The agent states what it has (lockfile, number of source files, Gemini key, live or snapshot data), lists the tools it will use, and explains any tool it will skip.
3. **Tools.** Parse lockfile → OSV.dev match → EPSS + KEV enrichment → fixed tier rules → Gemini code reading → OSV re-verification of upgrades.
4. **Decisions** (visible in the timeline), for example:
   - *"1 vulnerability is already exploited in real attacks; it goes straight to Fix now."*
   - *"No source code was given, so I will skip the code check and mark code usage as Not assessed instead of guessing."*
   - *"Your code reaches 2 vulnerable functions. AI may only raise a priority, never lower it."*
   - *"1 has no verified fix yet; I will say so instead of suggesting an unverified version."*
5. **Answer.**
   - `/overview`: funnel from all alerts → production → used by your code → fix now.
   - `/finding?key=…`: why it was ranked, the advisory, dependency chain, cited code, verified fix.
   - `/remediation`: exact `npm install` / `overrides` commands, verified vs unverified.
   - `/india`: verdict, next steps, CERT-In and DPDP obligations with official links, plain-language risk per finding, Hindi toggle, **Share on WhatsApp**.
   - `/reports`: Markdown and JSON export, history, before/after compare.

---

## 4. Demo data and fallbacks

| Situation | What to use | Notes |
| :--- | :--- | :--- |
| Normal | Live GitHub scan of `OWASP/NodeGoat` | Needs network + `GEMINI_API_KEY` for the code check |
| Venue Wi-Fi is slow | **Scan the bundled sample** (`samples/demo-app`, "QuickNotes") | Real pipeline run on a deliberately outdated Express app |
| No network at all | Start the server with `OFFLINE=1`, then scan the sample | Answers come from `data/snapshots` |
| Server down | **Explore demo data** | Illustrative, labelled "Demo data" everywhere, never saved to history |

Sample scan (offline snapshot) result: **251 packages → 76 known vulnerabilities in 21 packages → 56 in production → 3 Fix now**, with 21 of 21 packages having a verified clean version.

---

## 5. What is in and out of the MVP

| In | Out (named, not hidden) |
| :--- | :--- |
| npm `package-lock.json` (v2/v3) | Yarn, pnpm, Python, Java |
| Public GitHub repos by link; upload of lockfile + source folder | Private repos, GitLab, Bitbucket |
| Gemini code check for the top 30 direct findings | Full call-graph reachability analysis |
| Hindi + English on landing, scan, navigation, agent trace, India brief | Hindi in the deepest detail tables; other Indian languages |
| WhatsApp share link | WhatsApp bot, scheduled alerts (on the paid roadmap) |
| Browser-only history | Accounts, teams, server-side storage |
| CERT-In / DPDP information with sources | Legal advice; filing reports for the user |

---

## 6. Business case (close of the demo)

| Question PS3 asks | Answer |
| :--- | :--- |
| **Who pays** | Seed-stage Indian startups (**₹999 / month**) and dev agencies maintaining client apps (**₹4,999 / month**, 25 projects, white-label report in the client's language). Students and open source: free. |
| **What keeps them coming back** | The weekly re-scan that sends a WhatsApp alert the day a package they use appears on the exploited list. That is the feature they renew for. |
| **Cheapest channel for the first 100 users** | College tech clubs and hackathons (Geek Room, GDG chapters): free tier plus a "Scanned by Vulnera" README badge that spreads with every repo. Then helpful pull requests with fix plans on popular Indian open-source repos, and one free client report for agencies found on LinkedIn. |
| **Why they would pay** | One hour of a security consultant costs more than a year of the Startup plan. An agency can show clients a before/after report to justify a maintenance retainer. |

---

## 7. Judging criteria: where the points are

| Criterion (points) | Evidence to show |
| :--- | :--- |
| **Technical implementation (20)** | Streaming NDJSON agent protocol; codeload tarball reader with size and decompression caps (no GitHub API quota); batched OSV queries; OSV re-check of every upgrade target; citation validation; secret masking before AI; offline snapshot mode; single-process production build; offline self-checks in `server/src/pipeline/__checks__/` |
| **ML.ai implementation (10)** | Fill in [PITCH.md › How we used ML.ai](PITCH.md#mlai) with what the team actually built with the ML.ai agent, and show one session |
| **Innovation & originality (10)** | Three things together that no scanner does: does *your code* call the vulnerable function; Indian regulatory mapping; bilingual founder summary on WhatsApp |
| **User experience & design (10)** | Phone-first link flow, live agent timeline, Hindi toggle, verdict-first India brief, colour always paired with words |
| **Completeness & functionality (10)** | Input → plan → tools → decisions → fix → brief → export → history/compare, all working |
| **Presentation & demo (10)** | Three-minute script in [PITCH.md](PITCH.md), with fallbacks and judge Q&A |

---

## 8. Success criteria for the demo

- [ ] A judge can paste their own public repo link on their phone and see the agent's steps.
- [ ] Every number on screen links back to a source.
- [ ] The Hindi toggle changes the core journey, and the WhatsApp message is readable by a non-developer.
- [ ] Asked "what if the AI is wrong?", we can point at the rule: AI only raises, never lowers, and citations are machine-checked.
- [ ] The business case is said in rupees, with a named buyer and channel.
