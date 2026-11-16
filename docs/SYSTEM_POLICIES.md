# Vulnera system policies

These policies describe how Vulnera behaves: what it collects, what the AI is allowed to do, how facts are sourced, how input is handled, and what users may use it for. Each policy names the code that enforces it, so it can be checked rather than trusted.

**Applies to:** the Vulnera web app and API in this repository (MVP, November 2026).
**Owner:** the Vulnera team. **Review:** whenever a data source, AI model, or data flow changes.

| # | Policy | One-line rule |
| :--- | :--- | :--- |
| 1 | [Scope and intended use](#1-scope-and-intended-use) | Defensive triage of your own or public open-source projects only |
| 2 | [Personal data](#2-personal-data-policy) | With accounts on: GitHub id, login, name and email only; nothing else is asked for |
| 3 | [Data handling and retention](#3-data-handling-and-retention) | Project files are read in memory and not kept; signed-in scan results kept 90 days; source code and AI free text never stored |
| 4 | [AI usage](#4-ai-usage-policy) | AI reads code snippets and may raise a priority; it never creates, removes or lowers a finding |
| 5 | [Agent decisions and transparency](#5-agent-decision-and-transparency-policy) | Every step, decision and source is shown to the user |
| 6 | [Sources and citations](#6-source-and-citation-policy) | Every fact links to its source; unknowns are shown as unknown |
| 7 | [Input handling and execution safety](#7-input-handling-and-execution-safety) | Inputs are read as text, size-capped, never installed or executed |
| 8 | [Secrets and credentials](#8-secrets-and-credentials) | Keys stay on the server; secrets in code are masked before AI |
| 9 | [Language and accessibility](#9-language-and-accessibility-policy) | English, simple words, phone-first, colour never alone |
| 10 | [Availability and failure](#10-availability-and-failure-policy) | Fail visibly and honestly; degrade to rules, never to guesses |
| 11 | [Third-party services](#11-third-party-services) | What leaves the server, to whom, and why |
| 12 | [Acceptable use](#12-acceptable-use) | What users must not do with Vulnera |
| 13 | [Security issues and incidents](#13-security-issues-and-incident-response) | How to report a problem and how we respond |
| 14 | [Change control](#14-change-control) | How these policies and the rules behind them change |

---

## 1. Scope and intended use

**Vulnera is a defensive tool.** It reads a project's dependency list and source code and tells the owner which known, published vulnerabilities to fix first and how.

- Intended users: developers and teams triaging **their own projects**, or **public open-source projects** they depend on or contribute to.
- Vulnera does **not** discover new vulnerabilities, produce exploits, attack, probe or scan any running system, or test networks.
- Vulnera only reports vulnerabilities already published in OSV.dev. It does not claim a project is secure.

## 2. Personal data policy

Vulnera runs in one of two modes:

- **Accounts off** (no `DATABASE_URL`, GitHub OAuth app or `PUBLIC_ORIGIN` configured; `server/src/auth/config.ts` › `accountsEnabled`): a single-user tool with no accounts, no sign-in and no database. No personal data is collected or stored.
- **Accounts on** (the public deployment): people may sign in with GitHub. Anonymous use (the sample scan and a few public repository scans a day) still needs no account.

### What is stored when someone signs in

| Data | Source | Why | Code |
| :--- | :--- | :--- | :--- |
| GitHub numeric id | GitHub `/user` | Identify the account across logins (a renamed login keeps the same account) | `server/src/auth/routes.ts` (callback upsert) |
| GitHub login and display name | GitHub `/user` | Show who is signed in; confirm account deletion | same |
| Email address | GitHub `/user/emails`: the **primary, verified** address only | Contact about the account or a security issue; never shared or used for marketing | `server/src/auth/github.ts` › `fetchProfile` |
| Plan, created and last-login time | Vulnera | Quotas and housekeeping | `users` table |
| Session | Vulnera | Keep the browser signed in: only the **sha256 hash** of the session id is stored, with created, last-seen (updated at most every 10 minutes) and expiry times | `server/src/auth/session.ts` |
| API keys | Vulnera | Programmatic access: only a public id, the sha256 hash and the last 4 characters; the key itself is shown once | `api_keys` table |
| Saved scans and reviews | Vulnera | History, compare and reports for signed-in users | `server/src/scansStore.ts` |
| Monthly scan counters | Vulnera | Plan quotas | `usage` table |

- **GitHub sign-in asks only for `read:user user:email`** (read-only profile and email addresses). Vulnera cannot read the user's private repositories, organisations or anything else through it.
- **The GitHub access token is never stored or logged.** It is used for exactly two read calls (`/user` and `/user/emails`) during sign-in and then discarded (`server/src/auth/github.ts`). No avatar is fetched or stored.
- Sign-in uses OAuth with PKCE (S256) and a one-time `state` value, kept in a 10-minute signed cookie, never in the database.
- Never ask for Aadhaar, PAN, OTPs, bank or card details, passwords, phone numbers or addresses: no field exists for them, and the agent never prompts the user for anything. Payments, when they arrive, go through the payment provider; card details never reach Vulnera.

### Anonymous visitors

- With accounts on, anonymous scans are counted per IP address per day. The counter row stores an **unsalted sha256 of the IP and the day**, not the IP itself, and is **deleted by the hourly sweep once its day and the following day have passed (at most 2 days)** (`server/src/quota.ts`, `server/src/sweep.ts`). IPv6 addresses are counted by their /64 prefix, and IPv4-mapped IPv6 addresses as the IPv4 address. Because it is unsalted and IPv4 space is small, treat it as pseudonymous, not anonymous: it exists only to enforce the daily limit.
- Per-IP rate limits (scans, sign-in attempts) are counted in server memory only and forgotten within a day.

### Cookies

| Cookie | Set when | Contents | Lifetime | Flags |
| :--- | :--- | :--- | :--- | :--- |
| `__Host-vulnera_sid` (`vulnera_sid` on plain http) | After GitHub sign-in | Random 256-bit session id | 30 days (`SESSION_TTL_DAYS`), or until sign-out | HttpOnly, SameSite=Lax, Path=/, Secure on https |
| `vulnera_oauth` | Only while signing in | Signed one-time `state`, PKCE verifier and the page to return to | 10 minutes; cleared by the callback | HttpOnly, SameSite=Lax, Path=/auth, Secure on https |

These are strictly necessary cookies for signing in. There are **no analytics, tracking pixels, advertising or third-party cookies** (none are included in `client/`).

### Other rules

| Rule | How it is enforced |
| :--- | :--- |

If a scanned repository itself contains personal data (for example in fixtures), Vulnera does not extract, display or store it. Only short line windows around imports and uses of vulnerable packages can reach the AI, after best-effort secret masking (policy 8). Never whole files.

### Deleting an account

Signed-in users can delete their account from **Account › Danger zone** by typing their GitHub login (`DELETE /api/me`). This immediately deletes the user row and, by cascade, every session, API key, saved scan, review and usage counter belonging to it, and signs the browser out. Nothing is kept in the database afterwards (database backups held by the hosting provider age out on its own schedule). Signing out (`POST /api/auth/logout`) deletes that session row.

## 3. Data handling and retention

| Data | Where it goes | How long it is kept |
| :--- | :--- | :--- |
| Uploaded `package-lock.json` | Server memory during the scan | Discarded when the response is sent |
| Uploaded or GitHub source files | Server memory during the scan; only line windows around imports and uses to Gemini (policy 4). AI answers are kept in server memory for up to 24 hours (`server/src/cache.ts`), nothing is written to disk | Source files discarded when the response is sent; AI answers up to 24 h, in memory only |
| GitHub repository tarball | Downloaded to server memory, unpacked in memory | Discarded when the response is sent; never written to disk |
| Package names + versions | Sent to OSV.dev and the npm registry for lookups | Responses cached in `.cache/` on the server (public data, re-fetchable) |
| CVE ids | Sent to FIRST EPSS | Responses cached in `.cache/` |
| Scan results and reviews, signed in | Saved in the database with the user's account. A saved scan holds the findings (package, advisory, tier), the AI verdicts, and for each code citation only the **file path, line number and verdict**. **No source code and no AI free text is stored**: every code quote and every AI reasoning sentence is blanked before saving and shown only during the live scan (`server/src/scansStore.ts`). Revoked API keys are purged after 30 days (`server/src/sweep.ts`) | **90 days** (`SCAN_RETENTION_DAYS`), then deleted by the hourly sweep (`server/src/sweep.ts`); or earlier, when the user deletes the scan or the account |
| Scan results and reviews, anonymous or accounts off | Returned to the browser | Saved in the user's browser only (last 8 scans, `vulnera:history:v1`); never stored on the server |
| Account data (policy 2) | Database | Until the user deletes the account |
| Sessions | Database (hash only) | Until sign-out or expiry (30 days); expired rows deleted hourly |
| Anonymous daily IP counter | Database (hash of IP and day) | At most 2 days |
| Source files for code evidence | Kept in browser memory for the open tab only | Gone when the tab closes; never persisted |

- With accounts off the server has **no database**; there is nothing to breach beyond the public-data cache.
- With accounts on, the database holds only the data above. Every table has row level security with no policies, so a hosted provider's public REST API cannot read it; the app connects as the owner.
- Users can delete browser history at any time from **Reports & history › Clear history**, saved scans one by one, or everything by deleting the account (policy 2). Signing out clears Vulnera's data from the browser.
- **Demo data** is illustrative, labelled "Demo data" wherever it appears, and is never saved to history.

## 4. AI usage policy

Vulnera uses Google Gemini for **one job**: reading short line windows of the user's code to judge whether it calls the vulnerable function named in an advisory.

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

### Architecture context (not AI)
Exposure from the project's own files (docker-compose, Kubernetes, serverless.yml, Procfile, Dockerfile, OpenAPI, package.json, Markdown docs, `vulnera.yml`) and the import graph is computed **deterministically**, with every claim quoted from a file and line. It may lower a finding **one step**, never below Plan, never for CISA KEV, and never for "behind login" when anyone can sign up. Docs never override config or code; contradictions are reported. Unknown exposure counts as internet-facing (CISA SSVC default). Architecture files are never sent to Gemini. Details: [ARCHITECTURE_CONTEXT.md](ARCHITECTURE_CONTEXT.md).

### Human authority
- Apart from the one-step architecture rule above, only a person can lower a finding's tier, and never for KEV-listed findings.
- A person can confirm or dispute any AI verdict; the review is recorded with the scan and exported in reports.

### Model and limits
- Model: `gemini-2.5-flash-lite` by default (`GEMINI_MODEL` to change). Rate limited per key by `GEMINI_RPM` (default 4/min for the free tier; set 60 or more for paid keys). With several keys (`GEMINI_API_KEY_2`, ...) each call goes to the key with the earliest free slot, and a rate-limited key is skipped until its retry time.
- What is sent: only line windows, never whole files: the import lines plus 8 lines either side of every line that uses what was imported or names a vulnerable API from the advisory; at most 12 windows and 12,000 characters per file, 40,000 characters per call; long lines truncated to 300 characters. Line numbers stay absolute so citations can be checked. If a relevant file had to be cut, "not used" becomes `UNCERTAIN`.
- Limits per scan: at most the top **30** direct-dependency findings; up to 12 advisories per call; `AI_MAX_CALLS_PER_SCAN` live calls (default 20); no single wait for a Gemini slot longer than `AI_MAX_WAIT_MS` (default 60 s). Past either limit, or when the scan is cancelled, the AI step stops: remaining packages get no AI verdict ("Not assessed") and the scan says so.
- Storage: AI answers are cached in server memory only, for up to 24 hours; nothing is written to disk unless an operator turns on `CACHE_WRITE_DISK`.
- Data terms: use a **paid Gemini tier** for customer code. The free tier's data terms may allow Google to use inputs to improve its products; check Google's current terms before sending customer code.
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
- Every finding in the report shows its advisory id (and CVE) as the source.

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
- `DATABASE_URL` and `GITHUB_CLIENT_SECRET` (accounts on) live in the same server environment and are never sent to the browser or logged. The client secret also keys the HMAC that signs the short-lived sign-in cookie, so rotating it invalidates sign-ins in progress (not existing sessions).
- Session cookies and API keys are never logged; the database holds only their sha256 hashes.
- Before any code or advisory text reaches Gemini, likely secrets are masked as `[REDACTED]`, best effort (`pipeline/ai.ts` › `redact`): PEM blocks (private keys, certificates), JWT-like strings, credentials in connection strings (`scheme://user:pass@host`), Google API keys, OpenAI/Anthropic-style keys, AWS access key ids, GitHub tokens, Stripe live keys, values of quoted and unquoted assignments whose name contains `secret`, `token`, `passw`, `pwd`, `api_key`, `private_key`, `access_key` or `auth`, and long hex/base64 strings in string literals. Masking cannot catch every secret, so do not scan code you are not allowed to share with Google. Masking keeps line numbers unchanged so citations stay valid.
- Masking is best effort. Users should not commit secrets to repositories in the first place.
- No secrets are written to the agent trace, notes, logs shown to users, or reports.

## 9. Language and accessibility policy

- The interface is in English. Plain, everyday wording; technical identifiers (package names, versions, CVE ids, commands) are shown exactly.
- Phone first: the GitHub-link flow needs no files; layouts collapse to one column; tap targets are at least 44 px for primary actions.
- Colour is never the only signal: tiers, severities and risk levels always carry a word and usually an icon. Focus states are visible; live regions announce agent progress to screen readers; reduced-motion preferences turn off animations.

## 10. Availability and failure policy

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

## 11. Third-party services

| Service | What is sent | Why |
| :--- | :--- | :--- |
| OSV.dev (Google) | Package names and versions | Find known vulnerabilities and fixed versions |
| FIRST EPSS | CVE ids | Exploitation probability |
| CISA KEV | Nothing (catalogue download) | Known exploited list |
| npm registry | Package names | List versions for upgrade planning |
| GitHub (codeload) | Owner and repository name in the URL | Download a public repository as text |
| GitHub (OAuth, accounts on) | The sign-in redirect; then, server to server, the one-time code and PKCE verifier, and two read calls with the user's token | Sign in: read the GitHub id, login, name and primary verified email (policy 2) |
| Google Gemini | Masked line windows around imports and uses of vulnerable packages, advisory text | Code-usage verdicts |

No other services are contacted. Scan lookups send `User-Agent: vulnera-scanner` and no user identifiers; only the sign-in calls to GitHub carry the user's own token.

## 12. Acceptable use

Users must not:
- scan repositories they are not allowed to read, or try to use Vulnera to reach private code;
- use Vulnera to find targets to attack, or to support exploitation of third-party systems;
- automate high-volume requests against the public deployment (each scan downloads a repository and calls public APIs);
- submit content designed to manipulate the AI or crash the server (prompt injection, decompression bombs, oversized payloads).

The server enforces size, time and host limits (policy 7), runs at most `MAX_CONCURRENT_SCANS` scans at once (429 beyond that), and stops a scan when its browser disconnects. A public deployment should also add per-IP rate limiting at the proxy.

## 13. Security issues and incident response

- **Report a problem** with Vulnera itself (for example a way to make it read private data or execute code) by opening a private security advisory on the GitHub repository, or by contacting the maintainers directly. Please do not open a public issue for security bugs.
- **Our response:** acknowledge within 2 working days; fix or mitigate critical issues first; credit reporters who want it.
- **If Vulnera's own server is compromised**, the team will take the deployment offline, rotate the Gemini keys, review logs, and, where the CERT-In directions apply to the operator, report within 6 hours of noticing. The server stores no source code and no user projects, and keeps only the account data in policy 2 (no GitHub tokens; session ids and API keys only as hashes), which limits impact. If the database may have been exposed, the team will also delete all sessions (forcing sign-out), ask users to rotate API keys, rotate the GitHub OAuth client secret, and tell affected users.
- **Dependencies of Vulnera itself** are scanned with Vulnera before each release.

## 14. Change control

- Changes to tier rules (`pipeline/score.ts`), AI permissions (`pipeline/ai.ts`) or data flows must update this document and the relevant design doc in the same commit.
- Tier rules are fixed and published; there is no hidden weighting. A rule change is a visible code change with a review.
- Bump `PROMPT_VERSION` in `pipeline/ai.ts` whenever the AI prompt or output format changes, so old cached answers are not reused.
