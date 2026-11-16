# Vulnera documentation

| Document | For | What it covers |
| :--- | :--- | :--- |
| [MVP.md](MVP.md) | Judges, team | What we present: user, problem, PS3 requirement mapping, journey, scope, business case, criteria |
| [PITCH.md](PITCH.md) | Presenter | 3-minute demo script, fallbacks, judge Q&A, ML.ai usage log |
| [SYSTEM_POLICIES.md](SYSTEM_POLICIES.md) | Everyone | Personal data, retention, AI usage, agent transparency, sources, input safety, secrets, regulatory info, accessibility, failure, third parties, acceptable use, incidents |
| [AGENT.md](AGENT.md) | Engineers, judges | Tools, run order, every decision rule, tier rules, step record, example trace |
| [ARCHITECTURE_CONTEXT.md](ARCHITECTURE_CONTEXT.md) | Engineers, judges, mentors | Exploitability from architecture: research (SSVC, VEX), files read, how exposure is decided, the one-step policy, `vulnera.yml`, worked example, limits |
| [ARCHITECTURE.md](ARCHITECTURE.md) | Engineers | Layout, request lifecycle, pipeline stages, caching/offline, client, production topology, limits |
| [API.md](API.md) | Integrators | `/api/health`, `/api/scan/stream` (NDJSON), `/api/scan`, schemas, errors |
| [USER_GUIDE.md](USER_GUIDE.md) | Users | How to scan, read results, reports |
| [DEPLOYMENT.md](DEPLOYMENT.md) | Operators | Env vars, local, production, proxy, offline mode, venue checklist, troubleshooting |
| [../demo/README.md](../demo/README.md) | Anyone testing locally | Start scripts, demo projects, bad inputs, smoke test, click-through checklist |
| [TESTING.md](TESTING.md) | Engineers | Self-checks, smoke tests, manual end-to-end plan, accessibility checks |
| [DESIGN.md](DESIGN.md) | Designers, engineers | Design tokens and page contract (inherited from Vulnera) |
| [UI_AUDIT_HALLMARK.md](UI_AUDIT_HALLMARK.md) | Designers, engineers | Hallmark audit, the polish and restyle applied, what is waived |

**Background (Vulnera, Build-a-thon, 24 Oct 2026):** [PROJECT.md](PROJECT.md), [PLAN.md](PLAN.md), [TEAM.md](TEAM.md), [tasks/](tasks/). These describe the original pipeline Vulnera is built on. Where they disagree with the documents above, the documents above are current.
