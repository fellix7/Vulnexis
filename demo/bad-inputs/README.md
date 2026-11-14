# Bad inputs

Files that must be **refused with a clear message**, never a crash.

| File | Upload it on /scan as the lockfile | Expected message (roughly) |
| :--- | :--- | :--- |
| `lockfile-v1-npm6.json` | lockfileVersion 1 | "Unsupported lockfile: lockfileVersion 1 (npm 6 or older)…" with a regenerate hint |
| `empty-packages.json` | empty `packages` map | "…\"packages\" map is empty. Is this a complete npm lockfile?" |
| `not-json.json` | not JSON | Refused in the browser before anything is sent |
| `package.json` | a manifest, not a lockfile | Refused: no `packages` / `lockfileVersion` |

GitHub links that must fail politely (paste on /scan):

| Link | Expected |
| :--- | :--- |
| `https://gitlab.com/a/b` | "Only public github.com repositories are supported." |
| `https://github.com/expressjs/express` | "No package-lock.json found in this repository…" |
| `https://github.com/this-owner-does-not-exist-xyz/nope` | "Repository not found…" |
| `not a link` | The Run agent button stays disabled; inline hint |
