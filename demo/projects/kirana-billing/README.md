# kirana-billing (demo, deliberately vulnerable)

A tiny GST billing app for a kirana store with **outdated, vulnerable packages on purpose**, for testing Vulnexis. Do not install, run or deploy it.

| Package | Version | What the code does with it |
| :--- | :--- | :--- |
| ejs | 3.1.6 | `res.render(view, { ...req.query })`: the template-injection path (CVE-2022-29078) |
| lodash | 4.17.15 | `_.template(userInput)` and `_.merge({}, defaults, req.body)` |
| jsonwebtoken | 8.5.1 | `jwt.verify(token, key)` with no `algorithms` option |
| axios | 0.21.0 | `axios.get(req.query.url)` |
| node-fetch | 2.6.0 | forwards an auth header to a user-supplied URL |
| express | 4.17.1 | pulls in old `qs`, `body-parser`, `cookie` |
| mocha, minimist | dev only | should land in **Monitor** |

Expected in Vulnexis: several **Fix now** findings, code evidence pointing at `src/routes/*.js` (when a Gemini key is set), and an India brief verdict of **Act today**.
