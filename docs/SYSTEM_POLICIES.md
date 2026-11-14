# Vulnexis system policies

These policies describe how Vulnexis behaves: what it collects, what the AI is allowed to do, how facts are sourced, how input is handled, and what users may use it for. Each policy names the code that enforces it, so it can be checked rather than trusted.

**Applies to:** the Vulnexis web app and API in this repository (MVP, November 2026).
**Owner:** the Vulnexis team. **Review:** whenever a data source, AI model, or data flow changes.

| # | Policy | One-line rule |
| :--- | :--- | :--- |
| 1 | [Scope and intended use](#1-scope-and-intended-use) | Defensive triage of your own or public open-source projects only |
| 2 | [Personal data](#2-personal-data-policy) | No personal data is asked for, collected or stored |
| 3 | [Data handling and retention](#3-data-handling-and-retention) | Project files are read in memory and not kept; history stays in the user's browser |
| 4 | [AI usage](#4-ai-usage-policy) | AI reads code snippets and may raise a priority; it never creates, removes or lowers a finding |
| 5 | [Agent decisions and transparency](#5-agent-decision-and-transparency-policy) | Every step, decision and source is shown to the user |
| 6 | [Sources and citations](#6-source-and-citation-policy) | Every fact links to its source; unknowns are shown as unknown |
| 7 | [Input handling and execution safety](#7-input-handling-and-execution-safety) | Inputs are read as text, size-capped, never installed or executed |
| 8 | [Secrets and credentials](#8-secrets-and-credentials) | Keys stay on the server; secrets in code are masked before AI |
| 9 | [Regulatory information](#9-regulatory-information-policy) | CERT-In and DPDP content is information with sources, not legal advice |
| 10 | [Language and accessibility](#10-language-and-accessibility-policy) | Hindi and English, simple words, phone-first, colour never alone |
| 11 | [Availability and failure](#11-availability-and-failure-policy) | Fail visibly and honestly; degrade to rules, never to guesses |
| 12 | [Third-party services](#12-third-party-services) | What leaves the server, to whom, and why |
| 13 | [Acceptable use](#13-acceptable-use) | What users must not do with Vulnexis |
| 14 | [Security issues and incidents](#14-security-issues-and-incident-response) | How to report a problem and how we respond |
| 15 | [Change control](#15-change-control) | How these policies and the rules behind them change |

---

## 1. Scope and intended use

**Vulnexis is a defensive tool.** It reads a project's dependency list and source code and tells the owner which known, published vulnerabilities to fix first and how.

- Intended users: developers and teams triaging **their own projects**, or **public open-source projects** they depend on or contribute to.
- Vulnexis does **not** discover new vulnerabilities, produce exploits, attack, probe or scan any running system, or test networks.
- Vulnexis only reports vulnerabilities already published in OSV.dev. It does not claim a project is secure.

## 2. Personal data policy

Vulnexis is designed so that it never needs personal data.

| Rule | How it is enforced |
| :--- | :--- |
| No accounts, logins, sign-up forms or contact fields | The UI has no such inputs; the API accepts only `repoUrl`, `lockfile`, `sources`, `sample` (`server/src/types.ts` › `ScanRequest`) |
| Never ask for Aadhaar, PAN, OTPs, bank or card details, passwords, phone numbers or addresses | No field exists for them; the agent never prompts the user for anything |
| WhatsApp sharing collects nothing | The share button opens `https://wa.me/?text=…` with the summary only; no phone number is entered or stored (`client/src/pages/India.tsx`) |
| No analytics, tracking pixels or third-party cookies | None are included in `client/` |
| The language choice is a preference, not personal data | Stored only in the user's own browser (`localStorage` key `vulnexis:lang:v1`) |

If a scanned repository itself contains personal data (for example in fixtures), Vulnexis does not extract, display or store it. Only short code snippets around imports of vulnerable packages can reach the AI, after secret masking (policy 8).

## 3. Data handling and retention

| Data | Where it goes | How long it is kept |
| :--- | :--- | :--- |
| Uploaded `package-lock.json` | Server memory during the scan | Discarded when the response is sent |
| Uploaded or GitHub source files | Server memory during the scan; short snippets to Gemini (policy 4) | Discarded when the response is sent |
| GitHub repository tarball | Downloaded to server memory, unpacked in memory | Discarded when the response is sent; never written to disk |
| Package names + versions | Sent to OSV.dev and the npm registry for lookups | Responses cached in `.cache/` on the server (public data, re-fetchable) |
| CVE ids | Sent to FIRST EPSS | Responses cached in `.cache/` |
| Scan results and reviews | Returned to the browser | Saved in the user's browser only (last 8 scans, `vulnera:history:v1`); never stored on the server |
| Source files for code evidence | Kept in browser memory for the open tab only | Gone when the tab closes; never persisted |

- The server has **no database**. There is nothing to breach beyond the public-data cache.
- Users can delete history at any time from **Reports & history › Clear history**.
- **Demo data** is illustrative, labelled "Demo data" wherever it appears, and is never saved to history.

## 4. AI usage policy

Vulnexis uses Google Gemini for **one job**: reading short snippets of the user's code to judge whether it calls the vulnerable function named in an advisory.

### What the AI may do
- Return one verdict per advisory: `USES_VULNERABLE_API`, `NO_VULNERABLE_USAGE_FOUND` or `UNCERTAIN`, with up to two sentences of reasoning and line citations.
- **Raise** a finding's priority when it confirms, with a verified citation, that production code calls the vulnerable function.

### What the AI may never do
| Never | Enforcement |
| :--- | :--- |
| Create a vulnerability | Findings come only from OSV.dev matches (`pipeline/match.ts`); the AI only annotates existing findings |
| Remove a vulnerability | Rescoring keeps every finding; nothing is filtered out (`index.ts`, `pipeline/score.ts`) |
| Lower a priority | `tierFor` only uses `USES_VULNERABLE_API` to raise; other verdicts are ignored for tiering (`pipeline/score.ts`) |
| Override CISA KEV | A KEV-listed finding is always Fix now, regardless of AI or human review (`score.ts`, `client/src/lib/review.ts` › `canLower`) |
| Invent code | Every citation's quote is re-checked against the real file and line; a "uses" verdict with no surviving citation is downgraded (`pipeline/ai.ts` › `validateCitations`) |
| Claim "safe" when it saw too little | If any relevant file was too large to send in full, "not used" is downgraded to `UNCERTAIN` (`pipeline/ai.ts` › `analyzeChunk`) |
| Follow instructions in code or advisories | The system prompt marks advisory text and code as untrusted data and forbids following instructions inside them |
| Decide the regulatory brief | The India brief is deterministic templates filled from scan data (`client/src/lib/india.ts`); no AI text |

### Architecture context (not AI)
Exposure from the project's own files (docker-compose, Kubernetes, serverless.yml, Procfile, Dockerfile, OpenAPI, package.json, Markdown docs, `vulnexis.yml`) and the import graph is computed **deterministically**, with every claim quoted from a file and line. It may lower a finding **one step**, never below Plan, never for CISA KEV, and never for "behind login" when anyone can sign up. Docs never override config or code; contradictions are reported. Unknown exposure counts as internet-facing (CISA SSVC default). Architecture files are never sent to Gemini. Details: [ARCHITECTURE_CONTEXT.md](ARCHITECTURE_CONTEXT.md).

### Human authority
- Apart from the one-step architecture rule above, only a person can lower a finding's tier, and never for KEV-listed findings.
- A person can confirm or dispute any AI verdict; the review is recorded with the scan and exported in reports.

### Model and limits
- Model: `gemini-2.5-flash-lite` by default (`GEMINI_MODEL` to change). Rate limited by `GEMINI_RPM` (default 4/min for the free tier).
- At most the top **30** direct-dependency findings per scan; up to 12 advisories per call; 8 snippets per file with 3 lines of context; ~160,000 characters of code per call; long lines truncated to 300 characters.
- Findings the AI did not review are shown as **"Not assessed"**, which the UI states is *not the same as safe*.

## 5. Agent decision and transparency policy

The agent must be **inspectable**: a user can see what it did, with what, and why.

- Every run records an ordered list of steps (`server/src/agent.ts`): tool, title, status (`running`, `done`, `skipped`, `failed`), timing, input summary, output summary, **decision**, and **sources**.
- Steps are **streamed live** to the browser as they start and finish (`POST /api/scan/stream`) and saved with the scan for the `/agent` page.
- Step contents never include source code, secrets or API keys; inputs are summaries (for example "8 source files", "Gemini key: yes").
- Decisions that change what the agent does must be stated in the trace, including:
  - skipping the code check (no source code, or no AI key), and why;
  - sending a KEV-listed vulnerability straight to Fix now;
  - raising findings after code evidence;
  - moving findings down because of architecture context, with the files read and any docs-vs-code conflicts;
  - refusing to suggest an unverified upgrade version;
  - skipping files to stay within reading limits.
- A failed tool is shown as **failed**, with its message; the agent continues where the remaining data allows, and says what is missing.

## 6. Source and citation policy

- **Facts come from named data sources**, linked in the UI:

  | Fact | Source |
  | :--- | :--- |
  | Package has a vulnerability; severity; fixed versions | [OSV.dev](https://osv.dev) |
  | Probability of exploitation in the next 30 days | [FIRST EPSS](https://www.first.org/epss/) |
  | Exploited in real attacks | [CISA Known Exploited Vulnerabilities](https://www.cisa.gov/known-exploited-vulnerabilities-catalog) (snapshot in `data/kev.json`) |
  | Available versions for upgrades | [npm registry](https://registry.npmjs.org) |
  | Your code calls the vulnerable function | Gemini verdict + **verified** file:line citation |
  | CERT-In obligations | [CERT-In Directions, 28 April 2022](https://www.cert-in.org.in/PDF/CERT-In_Directions_70B_28.04.2022.pdf) |
  | DPDP obligations | [MeitY data protection framework](https://www.meity.gov.in/data-protection-framework) |

- **Unknown is shown as unknown.** Missing EPSS is "no data", never zero. Unreviewed code usage is "Not assessed". No verified fix is "no verified fix", never a guessed version.
- Advisory text from OSV is displayed as plain text (untrusted), never rendered as HTML.
- Every finding in the India brief's "In plain words" list shows its advisory id (and CVE) as the source.

## 7. Input handling and execution safety

| Input | Limits and handling | Code |
| :--- | :--- | :--- |
| Request body | JSON only, 10 MB max | `server/src/index.ts` (`express.json({ limit: '10mb' })`) |
| `package-lock.json` | Must be lockfileVersion 2 or 3 with a non-empty `packages` map; otherwise a clear error | `pipeline/parse.ts` |
| GitHub link | `github.com` only, public repositories only; `owner/repo`, full URL, `.git` suffix and `/tree/<ref>` accepted | `pipeline/github.ts` › `parseRepoUrl` |
| GitHub download | One anonymous tarball from `codeload.github.com`; **60 MB compressed**, **300 MB unpacked** max; 30 s timeout; no token is sent | `pipeline/github.ts` › `download` |
| Files read from a repo | Lockfile ≤ 10 MB; source files ≤ 200 KB each, ≤ 120 files, ≤ 3 MB total; `node_modules`, `dist`, `build`, minified, test and `.d.ts` files skipped | `pipeline/github.ts` |
| Uploaded source folder | ≤ 300 files and 3 MB, filtered in the browser before sending | `client/src/lib/sources.ts` |

- **Nothing from a project is ever installed, built, required or executed.** Repositories and uploads are parsed as text. There is no `npm install`, no `eval`, no child process on user input.
- The server only makes outbound requests to fixed hosts (OSV.dev, FIRST, CISA, npm registry, codeload.github.com, Gemini). A user-supplied link selects an owner and repository name on `codeload.github.com`; it cannot point the server at another host.

## 8. Secrets and credentials

- API keys (`GEMINI_API_KEY`, optional `GEMINI_API_KEY_2`, `_3`, …) live in the server's `.env`, which is git-ignored. They are never sent to the browser; `/api/health` reports only whether a key exists.
- Before any code or advisory text reaches Gemini, likely secrets are masked as `[REDACTED]` (`pipeline/ai.ts` › `redact`): private key blocks, Google API keys, OpenAI/Anthropic-style keys, AWS access key ids, GitHub tokens, Stripe live keys, and quoted values of fields named like `api_key`, `secret`, `token`, `password`. Masking keeps line numbers unchanged so citations stay valid.
- Masking is best effort. Users should not commit secrets to repositories in the first place.
- No secrets are written to the agent trace, notes, logs shown to users, or reports.

## 9. Regulatory information policy

- The India brief explains **CERT-In's 2022 directions** (6-hour incident reporting, 180-day log retention in India) and the **DPDP Act 2023** (Section 8(5) reasonable security safeguards, Section 8(6) breach intimation, penalties up to ₹250 crore under the Schedule).
- It is **information, not legal advice**. This is stated on the page, in the WhatsApp message and in these policies.
- Every obligation shows a link to the official source, and states whether it applies **now**, **if exploited**, or **always**, with a reason taken from the scan's data.
- Having a vulnerability is not presented as an "incident". The brief says reporting obligations start only if exploitation is noticed.
- The mapping is deterministic (`client/src/lib/india.ts`) and documented in [INDIA_COMPLIANCE.md](INDIA_COMPLIANCE.md). It is reviewed whenever the law, the rules under it, or CERT-In's directions change.

## 10. Language and accessibility policy

- The core journey (landing, navigation, scan, live agent trace, agent page, India brief, WhatsApp summary) is available in **Hindi and English**, switchable at any time; the choice is remembered in the browser. The first visit follows the browser language.
- Technical identifiers (package names, versions, CVE ids, commands) are never translated.
- Plain, everyday wording. Jargon gets a plain-language explanation in the India brief.
- Phone first: the GitHub-link flow needs no files; layouts collapse to one column; tap targets are at least 44 px for primary actions.
- Colour is never the only signal: tiers, severities and risk levels always carry a word and usually an icon. Focus states are visible; live regions announce agent progress to screen readers; reduced-motion preferences turn off animations.

## 11. Availability and failure policy

| Failure | Behaviour |
| :--- | :--- |
| OSV.dev unreachable | Scan fails with a clear message (facts cannot be invented) |
| EPSS unreachable | Scan continues; EPSS shown as "no data"; a note explains |
| KEV feed unreachable | Uses the saved `data/kev.json` snapshot |
| Gemini key missing | The agent skips the code check and says so; findings show "Not assessed" |
| Gemini error or quota | Affected findings become `UNCERTAIN`; the step is shown as such; rule-based tiers stand |
| GitHub unreachable / rate limited / repo too large / no lockfile | Clear, specific message suggesting upload instead |
| Offline mode (`OFFLINE=1`) | Answers from `data/snapshots`; a banner says so; an unknown project is refused rather than guessed |
| Client loses the stream | "The connection closed before the scan finished. Try again." |

The rule: **degrade to deterministic rules, never to guesses**, and always tell the user what was skipped.

## 12. Third-party services

| Service | What is sent | Why |
| :--- | :--- | :--- |
| OSV.dev (Google) | Package names and versions | Find known vulnerabilities and fixed versions |
| FIRST EPSS | CVE ids | Exploitation probability |
| CISA KEV | Nothing (catalogue download) | Known exploited list |
| npm registry | Package names | List versions for upgrade planning |
| GitHub (codeload) | Owner and repository name in the URL | Download a public repository as text |
| Google Gemini | Masked code snippets around imports of vulnerable packages, advisory text | Code-usage verdicts |
| WhatsApp (`wa.me`) | Only when the user taps Share: the summary text, in the user's own browser | Let the user send the summary |

No other services are contacted. The server sends `User-Agent: vulnexis-scanner` and no user identifiers.

## 13. Acceptable use

Users must not:
- scan repositories they are not allowed to read, or try to use Vulnexis to reach private code;
- use Vulnexis to find targets to attack, or to support exploitation of third-party systems;
- automate high-volume requests against the public deployment (each scan downloads a repository and calls public APIs);
- submit content designed to manipulate the AI or crash the server (prompt injection, decompression bombs, oversized payloads).

The server enforces size, time and host limits (policy 7), runs at most `MAX_CONCURRENT_SCANS` scans at once (429 beyond that), and stops a scan when its browser disconnects. A public deployment should also add per-IP rate limiting at the proxy.

## 14. Security issues and incident response

- **Report a problem** with Vulnexis itself (for example a way to make it read private data or execute code) by opening a private security advisory on the GitHub repository, or by contacting the maintainers directly. Please do not open a public issue for security bugs.
- **Our response:** acknowledge within 2 working days; fix or mitigate critical issues first; credit reporters who want it.
- **If Vulnexis's own server is compromised**, the team will take the deployment offline, rotate the Gemini keys, review logs, and, where the CERT-In directions apply to the operator, report within 6 hours of noticing. The server stores no personal data and no user projects, which limits impact.
- **Dependencies of Vulnexis itself** are scanned with Vulnexis before each release.

## 15. Change control

- Changes to tier rules (`pipeline/score.ts`), AI permissions (`pipeline/ai.ts`), the India mapping (`client/src/lib/india.ts`) or data flows must update this document and the relevant design doc in the same commit.
- Tier rules are fixed and published; there is no hidden weighting. A rule change is a visible code change with a review.
- Bump `PROMPT_VERSION` in `pipeline/ai.ts` whenever the AI prompt or output format changes, so old cached answers are not reused.
