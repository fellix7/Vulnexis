# Vulnera user guide

Vulnera tells you which vulnerable open-source packages in your Node.js project to fix first, why, and how.

**Scanning needs no personal information.** No login, no phone number, no Aadhaar or PAN.

---

## 1. Start a scan (`/scan`)

### Option A: GitHub link (best on a phone)
1. Paste your public repository link, for example `https://github.com/owner/repo`.
2. Tap **Run agent**. Or tap an example: **OWASP/NodeGoat**, **snyk-labs/nodejs-goof**.
3. The repository must contain an npm `package-lock.json`.

### Option B: Upload files
1. **Lockfile (required):** drop your `package-lock.json` (npm 7 or newer).
2. **Source folder (optional):** choose your project folder so the AI can check whether your code really calls the vulnerable function. Only JS/TS files are read (≤ 300 files, 3 MB).
3. Press **Run scan**.

### Option C: No project?
- **Scan the sample project:** a real scan of QuickNotes, a deliberately outdated demo app.
- **Explore demo data:** instant illustrative results, labelled "Demo data" and never saved.

## 2. Watch the agent work

While scanning, a live timeline shows each step. Every step shows:

| Part | Meaning |
| :--- | :--- |
| Tool chip (e.g. OSV.dev, Gemini) | What the agent used |
| IN | What went into the tool |
| OUT | What came back |
| Decision | What it decided next, and why |
| Source link | Where the fact came from |

A violet dashed chip means AI. Everything else is data or fixed rules.

After the scan, open **Agent trace** in the sidebar to see the full run again.

## 3. Read the results

### Overview (`/overview`)
The funnel: all known vulnerabilities → those in production code → those your code actually calls → **Fix now**.

### Priorities

| Tier | Meaning | What to do |
| :--- | :--- | :--- |
| 🔴 **Fix now** | Exploited in real attacks, or high/critical in production with high exploit probability or confirmed use by your code | Today |
| 🟠 **Fix this sprint** | Other high/critical production issues | This week or sprint |
| 🔵 **Plan** | Other production issues | Add to backlog |
| ⚪ **Monitor** | Development-only packages | Keep an eye on it |

### Findings (`/findings`)
Filter by tier, severity, production/dev, direct/transitive, AI verdict or KEV. Search by package or CVE. Open any finding for:
- **Why this priority:** the exact reasons.
- **Advisory:** the original text (shown as plain text).
- **Dependency chain:** which of your packages pulls it in.
- **Code evidence:** the AI verdict with the cited line of your code (citations are machine-checked).
- **Fix:** the verified upgrade and command.
- **Review:** confirm or dispute the AI verdict; lower a priority if you know better (not allowed for actively exploited ones).

### Code evidence (`/evidence`)
Every place where your code reaches a vulnerable function, with the verified file and line.

### Remediation (`/remediation`)
The smallest safe version for each package, re-checked so the upgrade does not land on another vulnerable version, with a copy-ready command such as:

```bash
npm install ejs@3.1.10
```

For packages you did not install directly, Vulnera names the parent package to upgrade, or gives an npm `overrides` command.

### Architecture (`/architecture`)
Vulnera reads your deployment files (docker-compose.yml, Kubernetes, serverless.yml, Procfile, Dockerfile, OpenAPI), your docs (ARCHITECTURE.md, SECURITY.md, README) and your code to see **who can reach each vulnerable package**: anyone on the internet, only logged-in users, only your private network, nobody (a nightly job), or no running code at all. A package that an attacker cannot easily reach moves down **one step**, with the exact file and line that shows it. Known-exploited bugs never move. If your docs say a route needs login but the code does not check, you get a yellow warning.

To give the upload this context, choose the **project folder** (step 2 on `/scan`): the YAML, Markdown and Dockerfile files in it are read automatically. Optional: add a `vulnera.yml` ([format](ARCHITECTURE_CONTEXT.md#6-declaring-it-yourself-vulnerayml)).

## 4. Reports and history (`/reports`)

- Download the report as **Markdown** or **JSON**.
- Without an account, your last 8 scans are saved **in this browser only**. Open, delete or clear them at any time.
- **Compare** two scans to see what your upgrades fixed.

## 5. Questions

**Does Vulnera run my code?**
No. It only reads files as text.

**What does the AI see?**
Only short snippets of your code around imports of vulnerable packages, with secrets masked.

**"Not assessed" means safe?**
No. It means the code check did not review that finding.

**Private repositories?**
Not by link. Upload the lockfile and source folder instead.

**Yarn or pnpm?**
Not yet. Generate an npm lockfile with `npm install --package-lock-only`.
