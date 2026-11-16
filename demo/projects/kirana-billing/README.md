# kirana-billing (demo, deliberately vulnerable)

A tiny GST billing app for a kirana store with **outdated, vulnerable packages on purpose**, for testing Vulnera. Do not install, run or deploy it.

| Package | Version | What the code does with it |
| :--- | :--- | :--- |
| ejs | 3.1.6 | `res.render(view, { ...req.query })` on the public invoice page: the template-injection path (CVE-2022-29078) |
| lodash | 4.17.15 | `_.template(userInput)` and `_.merge({}, defaults, req.body)`, only in the owner-only `/admin` router |
| jsonwebtoken | 8.5.1 | `jwt.verify(token, key)` with no `algorithms` option |
| axios | 0.21.0 | `axios.get(req.query.url)` on a public route |
| node-fetch | 2.6.0 | forwards an auth header on redirects, only in the nightly `supplier-sync` job |
| express | 4.17.1 | pulls in old `qs`, `body-parser`, `cookie` |
| mocha, minimist | dev only | should land in **Monitor** |

## Architecture files (for the exposure check)

| File | What Vulnera learns from it |
| :--- | :--- |
| `docker-compose.yml` | `web` publishes port 8080 (internet-facing); `supplier-sync` sits only on an `internal: true` network |
| `src/server.js` | `/admin` is mounted behind `requireOwner` (a JWT check) |
| `openapi.yaml` | which routes the contract says need the owner's JWT |
| `ARCHITECTURE.md` | the team's own description of each process |

Deliberate drift: `ARCHITECTURE.md` and `openapi.yaml` both say `/supplier` needs a login, but `src/server.js` mounts it with no auth middleware. Vulnera reports this and treats `/supplier` as public.

Expected exposure: **lodash → behind login** (moves down one step), **node-fetch → private network only** (moves down one step), axios / ejs / jsonwebtoken / express → reachable from the internet (unchanged).

Expected in Vulnera: several **Fix now** findings, code evidence pointing at `src/routes/*.js` (when a Gemini key is set), and an India brief verdict of **Act today**.
