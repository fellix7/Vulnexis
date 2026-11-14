# Kirana billing: architecture (demo)

Two processes, both built from this folder (see `docker-compose.yml`):

| Process | What it does | Who can reach it |
| :--- | :--- | :--- |
| `web` | Invoices, owner login, supplier prices, owner admin pages | Internet-facing on port 8080 |
| `supplier-sync` | Nightly stock sync from the supplier | Nobody: it runs on the private backend network |

- The `web` service is internet-facing: customers open invoice links from WhatsApp.
- The /admin pages are owner-only and require the owner's JWT login.
- The /supplier endpoints are protected by JWT as well.
- `supplier-sync` is a nightly job on the private backend network and is never exposed to the internet.
