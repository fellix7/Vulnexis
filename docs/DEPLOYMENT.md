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

### Hosting on a Node platform (Render, Railway, Fly.io, a VM)

| Setting | Value |
| :--- | :--- |
| Build command | `npm ci && npm run build` |
| Start command | `npm start` |
| Environment | `GEMINI_API_KEY`, optionally `GEMINI_RPM`, `GEMINI_MODEL` |
| Health check | `GET /api/health` |
| Memory | 1 GB recommended (a large repository tarball is unpacked in memory, capped at 300 MB) |

### Reverse proxy notes

- The live agent timeline uses a streamed response (`application/x-ndjson`). **Disable response buffering** for `/api/scan/stream`. The server already sends `X-Accel-Buffering: no` (nginx) and `Cache-Control: no-cache, no-transform`.
- Allow request bodies up to 10 MB, and requests to run for up to ~2 minutes (large repos plus the AI step).
- Add per-IP rate limiting for `/api/scan*` on a public deployment (for example 10 scans per minute per IP).

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

## 5. Offline demo mode

```bash
OFFLINE=1 npm run dev
```

- OSV, EPSS and npm answers come from `data/snapshots/`. The bundled sample always works.
- New repositories or lockfiles are refused with a clear message if their answers were never saved.
- To make a project available offline: scan it once online (answers land in `.cache/`), then copy the relevant `.cache/<namespace>/` files into `data/snapshots/<namespace>/`.
- The AI code check runs offline only if `data/snapshots/gemini-package/` exists (copied from `.cache/` after an online scan).

## 6. Venue checklist (hackathon day)

- [ ] `npm run build` passes on the demo laptop.
- [ ] `.env` has a working Gemini key; `/api/health` shows `"gemini": true`.
- [ ] Run `OWASP/NodeGoat` once to warm the cache (EPSS, npm, Gemini answers are reused).
- [ ] Phone on the same network can open the app (use the deployed URL, or `npx vite --host` in `client/` for LAN).
- [ ] Fallback ready: sample scan, `OFFLINE=1`, and demo data.
- [ ] Official links on `/india` open.
- [ ] Browser zoom at 110 to 125% for the projector; dark room friendly by default.

## 7. Troubleshooting

| Symptom | Cause | Fix |
| :--- | :--- | :--- |
| Every scan fails | The server cannot reach OSV.dev | Read the **Connection check** printed at startup (or `GET /api/doctor`): set `HTTPS_PROXY`, add `NODE_EXTRA_CA_CERTS`, or use another network. The bundled sample still works from saved data |
| "API not reachable" in the sidebar | Server not running | `npm run dev` from the repo root |
| Code evidence shows "Not assessed" everywhere | No `GEMINI_API_KEY`, or no source code given | Add the key, or scan by GitHub link / with a source folder |
| Many "uncertain" verdicts and quota notes | Free-tier Gemini rate limit | Add `GEMINI_API_KEY_2`, or raise `GEMINI_RPM` with a paid key |
| Timeline appears only at the end | A proxy is buffering the stream | Turn off buffering for `/api/scan/stream` |
| "No package-lock.json found" | Repo uses Yarn/pnpm or has no lockfile | Upload an npm lockfile (`npm install --package-lock-only`) |
| "Offline mode: this project has no saved snapshot" | `OFFLINE=1` with a new project | Unset `OFFLINE`, or use the sample |
