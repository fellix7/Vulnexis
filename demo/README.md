# Vulnexis demo kit: test it on your own machine

Everything you need to run Vulnexis locally and check that every part works before you present: two test projects, files that should be refused, start scripts, an automated smoke test and a click-through checklist.

```
demo/
├── start.sh / start.ps1          start Vulnexis (macOS/Linux · Windows)
├── smoke-test.mjs                automated check of the running server (PASS / FAIL)
├── projects/
│   ├── kirana-billing/           deliberately vulnerable GST billing app (lockfile + source)
│   └── clean-app/                current packages only: should find nothing
└── bad-inputs/                   files and links that must be refused politely
```

> The demo projects are **never installed or run**. They exist only to be scanned. Do not `npm install` inside them.

---

## 1. Start Vulnexis (2 minutes)

You need **Node.js 22 or newer** (`node -v`) and internet for live data.

**macOS / Linux**, from the repo root:

```bash
./demo/start.sh
```

**Windows (PowerShell)**, from the repo root:

```powershell
.\demo\start.ps1
```

The script installs dependencies (first run only), creates `.env` from `.env.example`, builds, and starts one server. It prints two addresses:

- `http://localhost:8787` for this computer
- `http://<your-ip>:8787` for your phone on the same Wi-Fi

**Turn on the AI code check:** open `.env`, set `GEMINI_API_KEY=` to a free key from https://aistudio.google.com/apikey, and restart. Without it everything works, but code usage shows "Not assessed".

**No internet?** Use `./demo/start.sh --offline` (or `-Offline` on Windows). The bundled sample and demo data still work; new projects are refused with a clear message.

**For live code changes** (hot reload) instead of a production build, use `npm run dev` from the repo root and open http://localhost:5173.

## 2. Run the automated smoke test (30 seconds)

In a second terminal, with the server running:

```bash
node demo/smoke-test.mjs
```

```bash
node demo/smoke-test.mjs --online
```

The `--online` form also scans `OWASP/NodeGoat` from GitHub. Expected result, online with a Gemini key: **all PASS, 0 skipped**. Offline: the upload and GitHub checks show **SKIP** with the reason. Any **FAIL** line says what broke.

| Check | What it proves |
| :--- | :--- |
| server reachable, web page served | The API is up and the production build is being served |
| sample scan streams agent steps | The live agent timeline protocol works end to end |
| sample scan has findings, tiers, verified upgrades | OSV, EPSS/KEV, ranking and upgrade verification all ran |
| upload: kirana-billing … | Your own lockfile + source upload path, Fix-now items, dev packages in Monitor |
| architecture: lodash behind login … | docker-compose.yml, the `/admin` auth mount and ARCHITECTURE.md were read; exposure set per package |
| architecture: docs/OpenAPI vs code drift | Vulnexis caught the docs claiming `/supplier` needs login when the code does not check |
| AI code check cites the demo routes | Gemini found the vulnerable calls in `src/routes/*.js`, with verified citations |
| upload: clean-app has no findings | The "nothing to fix" path |
| refuses … | Bad input gives a clear message, not a crash |
| missing asset is a 404 / app routes load | Production routing |
| GitHub link: OWASP/NodeGoat | The phone-friendly link flow (with `--online`) |

## 3. Click through it yourself (10 minutes)

Tick each line as you go. **Expected** is what you should see.

### A. GitHub link (do this on your phone too)
- [ ] Open `/scan`, tap **OWASP/NodeGoat**. **Expected:** the live timeline streams fetch → plan → parse → OSV.dev → EPSS·KEV → rank → Gemini → verify → report, each with output and decisions; then it opens the Overview.
- [ ] Open **Agent trace** in the sidebar. **Expected:** the same steps, tools used, sources cited, and the five rules.

### B. Upload the vulnerable demo project
- [ ] `/scan` → **Lockfile**: choose `demo/projects/kirana-billing/package-lock.json`.
- [ ] **Source folder**: choose `demo/projects/kirana-billing` (the browser asks to confirm the folder upload).
- [ ] **Run scan**. **Expected:** several **Fix now** findings (ejs, lodash, jsonwebtoken, axios…); mocha/minimist in **Monitor**.
- [ ] Open the ejs finding. **Expected** (with a Gemini key): "Your code calls…" with a citation to `src/routes/invoices.js`, marked as checked against the file.
- [ ] **Code evidence** page. **Expected:** cited lines in `invoices.js`, `auth.js`, `supplier.js`.
- [ ] **Architecture** (sidebar). **Expected:** two entry points: `web` (Reachable from the internet, quoting `docker-compose.yml:8`) and `supplier-sync` (Private network only); `/admin` behind `requireOwner`; a yellow box saying the docs and OpenAPI claim `/supplier` needs login but the code does not check; lodash and node-fetch under **Priority changes**, each moved down one step.
- [ ] Open the lodash finding → **Who can reach it**. **Expected:** "Behind login" with the quoted lines `src/routes/admin.js:4` and `src/server.js:16`.
- [ ] **Remediation**. **Expected:** exact `npm install …@…` commands, and `overrides` for transitive packages; copy one.

### C. India brief and Hindi
- [ ] **India brief**. **Expected:** verdict **Act today**, next steps, four Indian rules (DPDP 8(5), 8(6), CERT-In 6 hours, 180-day logs) each with a source link.
- [ ] Tap **Share on WhatsApp**. **Expected:** WhatsApp (or WhatsApp Web) opens with the "Vulnexis security report"; Vulnexis never asks for a number.
- [ ] Switch **हिंदी** (top right). **Expected:** navigation, verdict, summary, steps and rules in Hindi; package names unchanged. Reload: still Hindi.

### D. The clean project
- [ ] Upload `demo/projects/clean-app/package-lock.json`. **Expected:** zero findings; India brief verdict **In good shape**.

### E. Things that must fail politely
- [ ] Try every file and link in [`bad-inputs/README.md`](bad-inputs/README.md). **Expected:** a clear message each time, the page stays usable, "Try again" works.

### F. Reports and history
- [ ] **Reports & history**: download Markdown and JSON. Scan kirana-billing twice, then **Compare**. **Expected:** both scans listed; no changes between them.

### G. Phone
- [ ] On your phone, open the `http://<your-ip>:8787` address the start script printed. **Expected:** the landing page fits the screen; the GitHub-link flow and the India brief work. If it does not open, allow Node through the computer's firewall, or check that both are on the same Wi-Fi.

## 4. Before going on stage

- [ ] Smoke test: all PASS with `--online`.
- [ ] One NodeGoat scan done in the last hour (warms the cache, so the live demo is fast).
- [ ] Fallbacks ready: **Scan the sample project** and **Explore demo data** on `/scan`; `--offline` if the Wi-Fi dies.
- [ ] Script open: [`docs/PITCH.md`](../docs/PITCH.md).

## Troubleshooting

**Every scan fails?** Read the **Connection check** that the server prints in its terminal when it starts (also shown on the scan page after a failure, and by the smoke test). It lists each service Vulnexis needs (OSV.dev, EPSS, npm, GitHub, Gemini) as OK or BLOCKED, with the reason and what to do:

| Reason shown | Meaning | Fix |
| :--- | :--- | :--- |
| `ECONNRESET`, `ECONNREFUSED`, `UND_ERR_ABORTED`, `ETIMEDOUT` | The network blocks or drops the connection | Use the network's proxy: add `HTTPS_PROXY=http://host:port` to `.env` and restart. Or use a phone hotspot |
| `SELF_SIGNED_CERT_IN_CHAIN`, `UNABLE_TO_VERIFY_LEAF_SIGNATURE` | The network inspects HTTPS | Vulnexis already trusts your computer's certificates; if it still fails, add `NODE_EXTRA_CA_CERTS=/path/to/cert.pem` to `.env` |
| `ENOTFOUND` | No internet or DNS | Check the connection |
| `HTTP 403` on GitHub downloads | GitHub or the network refused the download | Vulnexis falls back to reading only the lockfile; or upload the files |
| Gemini `HTTP 400/403` | The API key is wrong | Fix `GEMINI_API_KEY` in `.env` (no quotes, no spaces) and restart |

If OSV.dev is blocked, the bundled sample still works (it uses saved data and says so), but new projects need OSV.dev.

| Problem | Fix |
| :--- | :--- |
| `git pull`: "local changes to package-lock.json would be overwritten" | That file was rewritten by `npm install`. Run `git checkout -- package-lock.json && git pull && npm ci` (`.env` is not touched) |
| `Vulnexis needs Node.js 22 or newer` | Install the current LTS from https://nodejs.org |
| Port 8787 already in use | Set `PORT=8790` in `.env`, then run the smoke test with `BASE=http://localhost:8790 node demo/smoke-test.mjs` |
| "Not assessed" everywhere | No `GEMINI_API_KEY` in `.env`, or no source folder chosen |
| Many "uncertain" verdicts | Free Gemini quota hit: add `GEMINI_API_KEY_2=` or wait a minute |
| "Offline mode: this project has no saved snapshot" | You started with `--offline`; restart without it |
| "Vulnexis is busy…" | More than 4 scans at once; wait, or raise `MAX_CONCURRENT_SCANS` |
| Timeline appears all at once at the end | A proxy or VPN is buffering responses; try without it |
| Windows: "running scripts is disabled" | Run `powershell -ExecutionPolicy Bypass -File .\demo\start.ps1` |
