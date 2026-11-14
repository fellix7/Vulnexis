# Kavach documentation

| Document | For | What it covers |
| :--- | :--- | :--- |
| [MVP.md](MVP.md) | Judges, team | What we present: user, problem, PS3 requirement mapping, journey, scope, business case, criteria |
| [PITCH.md](PITCH.md) | Presenter | 3-minute demo script, fallbacks, judge Q&A, ML.ai usage log |
| [SYSTEM_POLICIES.md](SYSTEM_POLICIES.md) | Everyone | Personal data, retention, AI usage, agent transparency, sources, input safety, secrets, regulatory info, accessibility, failure, third parties, acceptable use, incidents |
| [AGENT.md](AGENT.md) | Engineers, judges | Tools, run order, every decision rule, tier rules, step record, example trace |
| [ARCHITECTURE.md](ARCHITECTURE.md) | Engineers | Layout, request lifecycle, pipeline stages, caching/offline, client, production topology, limits |
| [API.md](API.md) | Integrators | `/api/health`, `/api/scan/stream` (NDJSON), `/api/scan`, schemas, errors |
| [INDIA_COMPLIANCE.md](INDIA_COMPLIANCE.md) | Engineers, reviewers | Risk categories, verdict rules, CERT-In / DPDP mapping, WhatsApp text, worked example |
| [USER_GUIDE.md](USER_GUIDE.md) | Users (EN + हिंदी) | How to scan, read results, use the India brief, reports |
| [DEPLOYMENT.md](DEPLOYMENT.md) | Operators | Env vars, local, production, proxy, offline mode, venue checklist, troubleshooting |
| [TESTING.md](TESTING.md) | Engineers | Self-checks, smoke tests, manual end-to-end plan, accessibility checks |
| [DESIGN.md](DESIGN.md) | Designers, engineers | Design tokens and page contract (inherited from Vulnera) |

**Background (Vulnera, Build-a-thon, 24 Oct 2026):** [PROJECT.md](PROJECT.md), [PLAN.md](PLAN.md), [TEAM.md](TEAM.md), [tasks/](tasks/). These describe the original pipeline Kavach is built on. Where they disagree with the documents above, the documents above are current.

**Claude Code skills:** the [ponytail](https://github.com/DietrichGebert/ponytail) review skills are vendored in `.claude/skills/` (MIT, SKILL.md files only, no hooks). Use `/ponytail-review` on a change or `/ponytail-audit` on the repo.
