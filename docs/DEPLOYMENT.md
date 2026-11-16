# Running and deploying Vulnera

## 1. Requirements

- Node.js 22 or newer (the server uses `--env-file-if-exists` and `import.meta.dirname`), npm 10+.
- Outbound HTTPS to: `api.osv.dev`, `api.first.org`, `registry.npmjs.org`, `codeload.github.com`, `generativelanguage.googleapis.com`. CISA KEV is read from `data/kev.json`.
- A Google Gemini API key for the code check (free at https://aistudio.google.com/apikey). Without one, everything else works and findings show "Not assessed".

## 2. Environment variables (`.env` at the repo root)

| Variable | Default | Purpose |
| :--- | :--- | :--- |
| `GEMINI_API_KEY` | none | Enables the AI code check |
| `GEMINI_API_KEY_2`, `_3`, … | none | Extra keys, each with its own free quota; used when one runs out |
| `GEMINI_MODEL` | `gemini-2.5-flash-lite` | Model for the code check |
| `GEMINI_RPM` | `4` | Requests per minute (free tier ≈ 5/min per model; raise to ~60 with a paid key) |
| `PORT` | `8787` | API (and, in production, app) port |
| `OFFLINE` | `0` | `1` = answer only from `data/snapshots` (demo without network) |
| `HTTPS_PROXY` / `HTTP_PROXY` / `NO_PROXY` | none | Route all outbound requests through a proxy (college/office networks) |
| `NODE_EXTRA_CA_CERTS` | none | Extra certificate file (.pem) for networks that inspect HTTPS. The OS certificate store is already trusted on Node 22.15+ |
| `MAX_CONCURRENT_SCANS` | `4` | Scans allowed at once per process; extra requests get a 429 "busy" message |

Never commit `.env`; it is git-ignored.

## 3. Local development

```bash
npm ci
```

(`npm ci` installs the exact versions in `package-lock.json` without rewriting it, so `git pull` never conflicts on the lockfile.)

```bash
cp .env.example .env
```

```bash
npm run dev
```

- API: http://localhost:8787 (auto-reload with `tsx watch`)
- App: http://localhost:5173 (Vite proxies `/api` to the API)
- API on another port: `VITE_API_TARGET=http://localhost:8788 npm run dev -w client`

## 4. Production (one process)

```bash
npm run build
```

```bash
npm start
```

`npm run build` compiles `server/dist` and `client/dist`. `npm start` runs `node server/dist/index.js`, which serves `/api/*`, the static client, and an SPA fallback, all on `PORT`.

## 5. Host it for demos

Accounts stay off until you add a database and a GitHub app, so the hosted site works like the local app: anyone can scan, nothing is stored. That is the right setup for showing Vulnera to investors and clients.

**Settings for any host**

| Variable | Value | Why |
| :--- | :--- | :--- |
| `PORT` | given by the host (the image defaults to 8080) | Port the app listens on |
| `TRUST_PROXY` | `1` (`2` behind Cloudflare plus the host) | Rate limits see the visitor's real address |
| `GEMINI_API_KEY` | your key | Turns on the AI code check. Without it, findings show "Not assessed" |
| `ADMIN_TOKEN` | a long random string | Lets you open `/api/doctor` with the `x-admin-token` header. Unset = `/api/doctor` returns 404 |

Leave `DATABASE_URL` unset. Health check: `GET /api/health`. Memory: 1 GB.

**Option 0: Vercel (quickest; Mumbai region)**

1. vercel.com → Add New → Project → import the GitHub repository. Vercel reads `vercel.json`; leave the build settings as they are.
2. Environment Variables: `TRUST_PROXY` = `1`, and `GEMINI_API_KEY` if you have one.
3. Deploy. You get `https://<project>.vercel.app`, and every push to `main` redeploys.

How it runs: the web app is served from Vercel's CDN, and one function (`api/index.mjs`) runs the Express server in `bom1` (Mumbai). Limits on Vercel:
- **Uploads are capped at 4.5 MB** per request (Vercel's limit). Scanning by GitHub link has no such cap; a large lockfile plus source folder upload can fail with "payload too large".
- **A scan must finish within 300 seconds** (the function limit; Vulnera's own deadline is 180 s, so this only matters if you raise `SCAN_DEADLINE_MS`).
- **Caches and rate limits live per function instance**, so they reset more often than on a single server. Fine for demos.
- **The Hobby plan is for personal, non-commercial use** under Vercel's terms. For client and investor work, use Pro, or Fly.io / Render below.

**Option A: Fly.io (Mumbai region, always on)**

```bash
fly launch --copy-config --no-deploy
```

```bash
fly secrets set GEMINI_API_KEY=your-key ADMIN_TOKEN=$(openssl rand -hex 24)
```

```bash
fly deploy
```

`fly.toml` keeps one 1 GB machine running in `bom` so the first visitor never waits for a cold start. Fly prints the `https://<app>.fly.dev` address.

**Option B: Render (Singapore)**

New + → Blueprint → pick this repository. Render reads `render.yaml`, builds the Dockerfile and asks for `GEMINI_API_KEY`. Use the Starter plan: the free plan sleeps and the first visit takes about a minute.

**Option C: any server with Docker**

```bash
docker build -t vulnera .
```

```bash
docker run -d --restart unless-stopped -p 8080:8080 -e TRUST_PROXY=1 -e GEMINI_API_KEY=your-key vulnera
```

Put nginx or Caddy in front for HTTPS (see below).

**Option D: a Node platform without Docker**

| Setting | Value |
| :--- | :--- |
| Build command | `npm ci && npm run build` |
| Start command | `npm start` |
| Node version | 22 |

**Before a demo**

- [ ] `/api/health` shows `"ok": true` (and `"gemini": true` if you set the key).
- [ ] Scan `OWASP/NodeGoat` once to warm the cache, so the live demo is fast.
- [ ] Open the site on your phone.

### Reverse proxy notes

- The live agent timeline uses a streamed response (`application/x-ndjson`). **Disable response buffering** for `/api/scan/stream`. The server already sends `X-Accel-Buffering: no` (nginx) and `Cache-Control: no-cache, no-transform`.
- Allow request bodies up to 10 MB, and requests to run for up to ~2 minutes (large repos plus the AI step).
- Per-IP scan limits are built in (`SCAN_RATE_PER_MIN`, `SCAN_RATE_PER_DAY`); set `TRUST_PROXY` so they see the real visitor.

nginx example:

```nginx
location /api/ {
  proxy_pass http://127.0.0.1:8787;
  proxy_buffering off;
  proxy_read_timeout 180s;
  client_max_body_size 10m;
}
location / {
  proxy_pass http://127.0.0.1:8787;
}
```

## 6. Offline demo mode

```bash
OFFLINE=1 npm run dev
```

- OSV, EPSS and npm answers come from `data/snapshots/`. The bundled sample always works.
- New repositories or lockfiles are refused with a clear message if their answers were never saved.
- To make a project available offline: scan it once online (answers land in `.cache/`), then copy the relevant `.cache/<namespace>/` files into `data/snapshots/<namespace>/`.
- The AI code check runs offline only if `data/snapshots/gemini-package/` exists (copied from `.cache/` after an online scan).

## 7. Venue checklist (hackathon day)

- [ ] `npm run build` passes on the demo laptop.
- [ ] `.env` has a working Gemini key; `/api/health` shows `"gemini": true`.
- [ ] Run `OWASP/NodeGoat` once to warm the cache (EPSS, npm, Gemini answers are reused).
- [ ] Phone on the same network can open the app (use the deployed URL, or `npx vite --host` in `client/` for LAN).
- [ ] Fallback ready: sample scan, `OFFLINE=1`, and demo data.
- [ ] Browser zoom at 110 to 125% for the projector; dark room friendly by default.

## 8. Troubleshooting

| Symptom | Cause | Fix |
| :--- | :--- | :--- |
| Every scan fails | The server cannot reach OSV.dev | Read the **Connection check** printed at startup (or `GET /api/doctor`): set `HTTPS_PROXY`, add `NODE_EXTRA_CA_CERTS`, or use another network. The bundled sample still works from saved data |
| "API not reachable" in the sidebar | Server not running | `npm run dev` from the repo root |
| Code evidence shows "Not assessed" everywhere | No `GEMINI_API_KEY`, or no source code given | Add the key, or scan by GitHub link / with a source folder |
| Many "uncertain" verdicts and quota notes | Free-tier Gemini rate limit | Add `GEMINI_API_KEY_2`, or raise `GEMINI_RPM` with a paid key |
| Timeline appears only at the end | A proxy is buffering the stream | Turn off buffering for `/api/scan/stream` |
| "No package-lock.json found" | Repo uses Yarn/pnpm or has no lockfile | Upload an npm lockfile (`npm install --package-lock-only`) |
| "Offline mode: this project has no saved snapshot" | `OFFLINE=1` with a new project | Unset `OFFLINE`, or use the sample |
