# Architecture context: can an attacker actually reach it?

A vulnerable package only matters if an attacker can get a request to the code that loads it. A bug in a library used only by a nightly job on a private network, or only by owner pages behind a JWT check, is real, but it is not as urgent as the same bug on a public route.

Vulnexis reads the project's own deployment files, docs and code, works out which processes run and who can reach them, and gives every vulnerable package an **exposure level**. That level can move a finding **down one step**, with every claim quoted from a file and line.

Code: `server/src/pipeline/context.ts` (deployment files, docs, merging), `server/src/pipeline/reach.ts` (import graph and auth mounts), the tier rule `applyExposure()` in `server/src/pipeline/score.ts`. Checks: `server/src/pipeline/__checks__/context.check.ts` (offline; one case per rule below).

---

## 1. Research: what the industry already uses

| Source | What we took from it |
| :--- | :--- |
| **CISA SSVC, "System Exposure"** ([CERT/CC reference](https://certcc.github.io/SSVC/reference/decision_points/system_exposure/)) | Three values: *open* (internet or a widely accessible network), *controlled* (networked, with access restrictions or mitigations), *small* (local or highly controlled, no exposed interface). **If exposure is unknown, assume open.** Vulnexis maps every level onto these three. |
| **CISA VEX status justifications** ([CISA PDF](https://www.cisa.gov/sites/default/files/2023-01/VEX_Status_Justification_Jun22.pdf)) | `vulnerable_code_not_in_execute_path`: the code ships but is never executed. Vulnexis uses it only when no entry point loads the package *and* the whole import graph could be followed. We deliberately do **not** claim `vulnerable_code_cannot_be_controlled_by_adversary`: a login wall reduces exposure, it does not make the code unreachable. |
| **CVSS environmental metrics** (Modified Attack Vector) | The same vulnerability scores lower when the vulnerable component is only reachable from an adjacent or local network. Exposure is that idea, applied from evidence instead of a form field. |
| **Reachability analysis** in commercial SCA tools | Following imports from entry points to the package. We do it on plain text (no build, no execution), and only claim "not reached" when the graph is complete. |
| **Cloud "internet exposure" context** in CNAPP tools | Joining Kubernetes Services, Ingresses and load balancers to workloads to decide what faces the internet. We do the same from the manifests in the repository. |

## 2. What Vulnexis reads

| File | Detected by | What it tells us |
| :--- | :--- | :--- |
| `vulnexis.yml` / `.vulnexis.yml` | name | The team's own declaration (see §6) |
| `docker-compose*.yml`, `compose.yml` | name | `ports` published (not on `127.0.0.1`) → internet-facing; `network_mode: host` → internet-facing; only `internal: true` networks → private; no ports at all in the file → private; **a service with no ports while another service in the file publishes one, or ports bound only to `127.0.0.1` / `localhost` / `::1`, → unknown** (a reverse proxy may forward to it); `command` / `entrypoint` → start file |
| Kubernetes YAML | `kind:` in content | Ingress → Service → workload = internet-facing (auth annotations = behind login); `LoadBalancer` / `NodePort` = internet-facing; `ClusterIP` only = private; `CronJob` / `Job` = no network entry point; container `command` / `args` → start file |
| `serverless.yml` | name | `http` / `httpApi` / `alb` / `websocket` events = internet-facing (with `authorizer` = behind login); `schedule` = offline; queues and streams = private; `handler` → start file |
| `Procfile` | name | `web` = internet-facing; `release` / `clock` = offline; other process types = private |
| `Dockerfile` | name | `CMD` / `ENTRYPOINT` → start file for the compose service or workload built from it |
| OpenAPI / Swagger (YAML or JSON) | `openapi:` / `swagger:` in content | Which route prefixes the contract says need a token (`security`, JWT bearer schemes); cross-checked against the code |
| `package.json` | name | `scripts.start` / `main` → start file; `bin` → command-line tool (offline) |
| Markdown: `ARCHITECTURE.md`, `SECURITY.md`, `THREAT_MODEL.md`, `README.md`, `docs/**/*.md` | name / folder | Plain-English claims such as "never exposed to the internet", "requires the owner's JWT login", "nightly job", tied to a component or route prefix named on the same line. **Evidence only: Markdown never changes exposure.** |
| Source code (`.js .ts .jsx .tsx .mjs .cjs`) | extension | `require` / `import` graph, `.use('/prefix', guard, router)` mounts, `router.use(requireAuth)`, `@UseGuards(...)`, servers that `.listen()`, public sign-up routes |

Start commands are resolved to source files: `npm start` → the `start` script, `node dist/server.js` → `src/server.ts`, `node .` → `main`. Limits: 60 architecture files, 256 KB each, 1.5 MB in total. Architecture files are read on the server and **never sent to Gemini**.

## 3. How a verdict is built

1. **Entry points.** Each process from the files above, with an exposure and the lines that prove it. With no deployment files, `package.json` start/main and any file that starts a server become entry points with **unknown** exposure.
2. **Merge.** The same component seen in several files keeps the **more exposed** reading. Disagreements are reported.
3. **Docs.** A Markdown claim is kept as evidence next to the component and never changes its exposure (not even when it is unknown). When it claims something safer than config or code, or safer than "unknown", Vulnexis reports a conflict.
4. **Import graph.** From each entry point, Vulnexis walks relative imports (and monorepo workspace packages). A router mounted behind an auth middleware (guard line before the mount, prefix match on a path-segment boundary), or a route file whose `router.use(requireAuth)` comes before its first route, caps everything below it at **behind login**. Optional or non-auth middleware (`optionalAuth`, `auth({ authRequired: false })`, rate limiters, CORS, loggers, plain `session`) is never a guard. A file that names a package in a string (for example `app.set('view engine', 'ejs')`) counts as loading it, because frameworks load those by name.
5. **Per package.** The package's exposure is the most exposed file that loads it, directly or through the direct dependency that pulls it in (a transitive package inherits from every direct dependency whose tree contains it).

| Level | Meaning | SSVC | Effect on the tier |
| :--- | :--- | :--- | :--- |
| Reachable from the internet | Loaded by an internet-facing entry point without a login wall | open | none |
| Exposure unknown | Not enough context | open (SSVC default) | none |
| Behind login | Only loaded below an auth middleware | controlled | down one step, **unless anyone can sign up** |
| Private network only | Only loaded by a process with no published port or on an internal network | controlled | down one step |
| No network entry point | Only loaded by a cron job, batch job or CLI | small | down one step |
| Not loaded by any entry point | Every file that imports it is clearly non-production (tests, `scripts/`, `tools/`, seeds, migrations, fixtures, mocks, examples, docs, `*.config.*`, rc files), no entry point reaches them, the graph is complete, and the package is not named in a start command or script | small · VEX `vulnerable_code_not_in_execute_path` | down one step |

## 4. Policy (what architecture context may never do)

- Lower a finding **more than one step**, or **below Plan**.
- Lower anything on **CISA KEV** (exploited in the wild).
- Lower a "behind login" finding when the code has a **public sign-up route** (`/register`, `/signup`, …): anyone can get past that wall.
- Let **docs set exposure**. Docs are evidence; contradictions are shown in the UI and in the scan notes.
- Trust a **third-party repo's `vulnexis.yml`**. `buildContext({ trustDeclarations: false })` (the server passes `!req.repoUrl`) shows declarations as evidence and a note, but they set no exposure; compose, Kubernetes, serverless and Procfile still count.
- Claim **"not loaded"** when the graph is incomplete or the importer might run: browser code, a worker started by a non-start script, a package preloaded with `node -r pkg` / `--require pkg` / `npx pkg` (any package.json script, Procfile, Dockerfile or start command naming it), or a package no scanned file imports (all "unknown"). Also incomplete: dynamic `require(variable)`, file-based routing frameworks in the root or any workspace (Next.js, Nuxt, Remix, SvelteKit, Gatsby, Astro, …), source lines over 2,000 characters or files over 400 KB (not analysed), skipped source files, or an entry point whose start file is not in the scanned code. In those cases the level is "unknown".
- Use AI. Exposure is computed deterministically from quoted lines; the Gemini rule ("AI may only raise a priority") is unchanged.

## 5. Where it shows up

- **Agent trace:** a "Mapping the architecture" step (tool: Architecture) between enrichment and ranking, citing SSVC and VEX.
- **Architecture page** (`/architecture`): findings per exposure level, entry points with quoted evidence, routes behind login, docs-vs-code conflicts, every priority change with its reason, files read.
- **Finding detail:** "Who can reach it", with the lines that support it, and why it was or was not lowered.
- **Findings list:** a marker on rows that moved, and the `?exposure=login|internal|offline|unreached|public|unknown` filter.
- **Markdown report:** an Architecture table and an exposure line per finding.
- **API:** `finding.exposure` and `result.context` (see [API.md](API.md)).

## 6. Declaring it yourself: `vulnexis.yml`

For anything config cannot show (a service behind a corporate VPN, an internal admin tool), add a file at the project root:

```yaml
components:
  web:
    entry: src/server.js
    exposure: public        # public | internal | login | offline
  admin:
    entry: src/admin.js
    exposure: public
    auth: required          # public + auth: required = behind login
  reports:
    entry: src/jobs/reports.js
    exposure: offline
    note: Runs nightly from cron, takes no requests.
```

A list form (`components: [{ name, entry, exposure }]` ) also works. For a repository you scan but do not own, declarations are ignored for exposure (see §4). If `vulnexis.yml` and a compose file disagree, the more exposed reading wins and the conflict is reported.

## 7. Worked example: `demo/projects/kirana-billing`

| Package | Where the code uses it | Exposure | Tier change |
| :--- | :--- | :--- | :--- |
| lodash | `src/routes/admin.js`, mounted at `src/server.js:16` behind `requireOwner` | Behind login | down one step |
| node-fetch | `src/jobs/supplier-sync.js`, the `supplier-sync` service on an `internal: true` network | Private network only | down one step |
| axios | `src/routes/supplier.js`, public route | Internet | none |
| ejs, jsonwebtoken, express (+ qs, body-parser…) | public routes / `src/server.js` | Internet | none |

It also shows drift detection: `ARCHITECTURE.md:12` and `openapi.yaml:34` say `/supplier` needs a login, but `src/server.js:15` mounts it with no auth middleware. Vulnexis reports both and keeps `/supplier` public.

## 8. Known limits

- Express-style `.use()` / Fastify `.register()` mounts and Nest `@UseGuards` are understood. Guards applied per route (`router.get('/x', requireAuth, …)`) are not, so those routes count as unguarded (safe direction). A `@UseGuards(...)` counts only above the single `class` of the file, naming Auth/Jwt/Session/Role and not Throttler. Ingress `auth-type` counts only with a real value (`none`, empty, `false` do not). Regex analysis is linear: lines over 2,000 characters and files over 400 KB are skipped and make the graph incomplete.
- Guard detection is by name (`requireAuth`, `verifyToken`, `passport.authenticate`, `expressjwt`, `…Auth`, `…Guard`). A custom guard with an unusual name is missed, so the route stays public (safe direction). Declare it in `vulnexis.yml` if needed.
- Kubernetes workloads link to code through container `command`/`args` or a single Dockerfile. Helm templates are not rendered.
- Only npm projects (the lockfile requirement of Vulnexis as a whole).
