# Vulnexis agent design

PS3 asks for an agent that "plans its steps, uses tools or data and decides what to do next, beyond what a plain chatbot does", with "its reasoning visible to the user". This document describes exactly how Vulnexis's agent does that.

## 1. Design principles

1. **Tools for facts, rules for priorities, AI for reading code.** Each job goes to the component that can do it reliably.
2. **Every decision is written down.** Anything that changes what happens next appears in the trace as a `decision`.
3. **Honest about gaps.** A skipped tool is shown as skipped, with the reason. Unknown stays unknown.
4. **AI is bounded.** It can raise a priority with evidence. It cannot create, remove or lower a finding.

## 2. Tools

| Tool id | Label (EN / HI) | What it calls | Inputs | Output |
| :--- | :--- | :--- | :--- | :--- |
| `github` | Fetch / प्रोजेक्ट लाना | codeload.github.com tarball, or the bundled sample | repo link | lockfile + source files |
| `plan` | Plan / योजना | internal | what was provided + server capabilities | tool list and the skip decision |
| `parse` | Parse / पढ़ना | internal (`parse.ts`) | lockfile | packages with direct/dev flags and chains |
| `osv` | OSV.dev | OSV `querybatch` + `vulns/{id}` | name + version list | advisories, severity, fixed versions |
| `enrich` | EPSS · KEV | FIRST EPSS API; CISA KEV snapshot | CVE ids | exploit probability, exploited flag |
| `context` | Architecture / आर्किटेक्चर | internal (`context.ts`, `reach.ts`) | deployment files, docs, import graph | entry points, exposure per package, conflicts |
| `rank` | Rank / प्राथमिकता | internal (`score.ts`) | matches + enrichment (+ verdicts) | tiers + reasons |
| `gemini` | Gemini | Google Gemini | masked snippets + advisory text | verdict + verified citations |
| `verify` | Verify / जाँच | OSV re-query + npm registry | candidate versions | smallest clean version + command |
| `report` | Report / रिपोर्ट | internal | all of the above | summary and next action |

## 3. Run order and decisions

```
[github]? ─► [plan] ─► [parse] ─► [osv] ─► [enrich] ─► [context]? ─► [rank] ─► [gemini | skipped] ─► [rank: re-ranked]? ─► [verify] ─► [report]
```

### 3.1 Plan
The plan step's input line lists: lockfile present, number of source files, whether a Gemini key exists, and live vs snapshot data. Its output lists the tools in order. The decision is one of:

| Condition | Decision text |
| :--- | :--- |
| Source files and (Gemini key or saved AI snapshots) | "Source code is available, so I will check whether your code actually calls each vulnerable function." |
| No source files | "No source code was given, so I will skip the code check and mark code usage as 'Not assessed' instead of guessing." |
| Source files but no key | "No Gemini key on this server, so I will skip the code check and say so rather than guess." |

### 3.2 OSV match
Decision: if nothing matched, "Nothing matched, so there is nothing to rank. Stopping early." Otherwise: "Facts come from this lookup only. AI never adds or removes a finding."

### 3.3 Enrichment
Output: count on CISA KEV and count with EPSS ≥ 10%. If any are on KEV: "N vulnerabilities are already exploited in real attacks; these go straight to 'Fix now'."

### 3.3b Architecture context
Runs when there are matches and the project provided source files or architecture files. Output: each entry point with its exposure, routes behind login, and the number of docs-vs-code conflicts (each also added to the scan notes). Decision: "Packages loaded only behind login, on a private network, offline, or by nothing at all move down one step (never below Plan, never if exploited in the wild). Unknown exposure counts as internet-facing." Sources cited: CISA SSVC (System Exposure) and CISA VEX justifications. Full rules: [ARCHITECTURE_CONTEXT.md](ARCHITECTURE_CONTEXT.md).

### 3.4 Ranking rules (fixed and published, `pipeline/score.ts`)

| Tier | Rule (first match wins) |
| :--- | :--- |
| **Fix now** | On CISA KEV; **or** High/Critical **and** production **and** (EPSS ≥ 10% **or** AI confirmed your code calls the vulnerable API) |
| **Fix this sprint** | Production **and** (High/Critical, **or** Moderate/Unknown with EPSS ≥ 10%) |
| **Plan** | Any other production finding |
| **Monitor** | Development-only dependency |

Then the **architecture step** (`applyExposure`): exposure *behind login*, *private network only*, *no network entry point* or *not loaded by any entry point* moves Fix now → Fix this sprint and Fix this sprint → Plan. Never below Plan, never for KEV, never for behind-login when sign-up is open.

Sort within tiers: higher EPSS, then severity, then name and id. Each finding carries reasons such as `On CISA KEV`, `EPSS 21%`, `Severity: High`, `Production dependency`, `Via express → body-parser`, `Your code calls template (src/routes/render.js:12)`.

Decision after the first ranking: "Next: read the code for the top N direct-dependency findings, most urgent first", or "Ranking is final for this run (no code check)."

### 3.5 Code investigation (Gemini)
- Scope: the first 30 **direct** findings in priority order, grouped by package.
- For each package: find files that import it (`require`, `import`, dynamic `import()`, re-exports). If none: verdict `NO_VULNERABLE_USAGE_FOUND`, "Package is not imported in the provided source code", with no AI call.
- Otherwise build numbered snippets (8 per file, 3 lines of context, masked secrets) and ask Gemini for one result per advisory.
- **Validation:** each citation's quote must match the real line; a `USES_VULNERABLE_API` verdict left with no valid citation is downgraded. If files were truncated, "not used" becomes `UNCERTAIN`.
- Output: counts of used / not used / uncertain and the number of verified citations.
- Decision:
  - error → "The AI step failed; findings keep their rule-based tier and say 'uncertain'."
  - some used → "Your code reaches N vulnerable functions. AI may only raise a priority, never lower it."
  - none used → "No confirmed calls. 'Not found' is shown as needing human review, not as safe."

### 3.6 Re-rank
If verdicts raised findings, an extra `rank` step appears: "Re-ranked: N findings raised to Fix now by code evidence."

### 3.7 Verify upgrades (`pipeline/plan.ts`)
1. For each vulnerable `name@version`, the candidate is the highest of "next fixed version above current" across its advisories. If any advisory has no fix above the current version → no candidate.
2. Re-query OSV for every candidate (one batch).
3. Candidates that are still vulnerable: fetch versions from npm, take the next 5 stable releases above the candidate, query OSV for all of them, and pick the first clean one.
4. Command: direct dependency → `npm install [-D] name@to`; transitive → `npm pkg set overrides.name=to` (dotted names get a JSON snippet); the direct parent is named.

Decision: "Every upgrade target was re-checked and is clean", or "N have no verified fix yet; I will say so instead of suggesting an unverified version."

### 3.8 Report
Output: total findings, Fix-now count, "Hindi + English summary · CERT-In / DPDP brief". Decision: "Start with the N Fix now items", or "Nothing needs an emergency fix. Work through the sprint list."

## 4. The step record

```ts
interface AgentStep {
  id: string;                 // "s1", "s2", … in order
  tool: 'plan' | 'github' | 'parse' | 'osv' | 'enrich' | 'rank' | 'gemini' | 'verify' | 'report';
  title: string;              // what the agent is doing, e.g. "Matching 251 packages against OSV.dev"
  status: 'running' | 'done' | 'skipped' | 'failed';
  startedAt: number;          // ms since scan start
  ms?: number;                // duration when finished
  input?: string;             // summary of what went in (never code or secrets)
  output?: string;            // summary of what came back
  decision?: string;          // what the agent decided next, and why
  sources?: { label: string; url: string }[];
}
```

## 5. Example trace (bundled sample, offline snapshots, no Gemini key)

| # | Tool | Title | Output | Decision |
| :--- | :--- | :--- | :--- | :--- |
| 1 | github | Loading the bundled sample project | package-lock.json + 8 source files | |
| 2 | plan | Planning the investigation | parse → OSV → EPSS+KEV → rank → verify | No Gemini key on this server, so I will skip the code check and say so rather than guess. |
| 3 | parse | Read 251 installed packages | 10 direct · 241 transitive · 173 dev-only | |
| 4 | osv | Matching 251 packages against OSV.dev | 76 known vulnerabilities in 21 packages | Facts come from this lookup only… |
| 5 | enrich | Checking 76 advisories for real-world exploitation | 0 on CISA KEV · 3 with EPSS ≥ 10% | |
| 6 | rank | Ranking findings with fixed, published rules | 3 fix now · 23 this sprint · 30 plan · 20 monitor | Ranking is final for this run (no code check). |
| 7 | gemini | Code check skipped | No Gemini key configured | *(skipped)* |
| 8 | verify | Finding the smallest safe upgrade for each package | 21 of 21 packages have a verified clean version · 4 need a major upgrade | Every upgrade target was re-checked and is clean. |
| 9 | report | Preparing the report | 76 findings · 3 to fix now · … | Start with the 3 Fix now items. |

## 6. Why this is an agent and not a chatbot

- It acts on a **real input** (a repository), not a conversation.
- It **chooses its tools** per run and explains omissions.
- It **calls external tools** and uses their results to decide the next step (stop early, raise a tier, try the next version, refuse a fix).
- Its result is **actionable** (commands, a fix order, a brief to send), and every claim is traceable to a tool output and a source.
