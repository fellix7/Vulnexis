# Vulnexis: demo script and pitch (3 minutes)

Problem Statement 3: Open Innovation. Judged out of 70: Technical 20, ML.ai 10, Innovation 10, UX 10, Completeness 10, Presentation 10.

## Before you go on stage

- [ ] `.env` has a working `GEMINI_API_KEY`; the server is running **without** `OFFLINE=1`.
- [ ] Run **OWASP/NodeGoat** once before judging. The first run warms the cache, so the live demo is fast.
- [ ] Open a second tab on `/scan` with the bundled sample, as a fallback if the venue Wi-Fi drops (`OFFLINE=1` also works for the sample).
- [ ] Phone ready, with the deployed URL open, to show it works on a phone browser.
- [ ] Open both official links on `/india` once and confirm they still load.

## Script

**0:00 · Problem (20 s)**
> "Every Indian startup ships on open source. Run `npm audit` on a normal app and you get 70+ alerts in English security jargon. Nobody on a 3-person team knows which ones matter. And since the DPDP Act, 'we didn't know' can cost up to ₹250 crore."

**0:20 · Real input, on a phone (20 s)**
Open `/scan` on the phone (or a narrow window). Tap **OWASP/NodeGoat**.
> "No login, no upload, no personal data. Just a GitHub link."

**0:40 · The agent works live (40 s)**
Point at the timeline as steps stream in:
> "This is an agent, not a chatbot. It **planned**: source code is available, so it will check code usage. It's calling OSV.dev for facts, EPSS and CISA's exploited list for real-world risk. Look at each **decision**: an exploited bug goes straight to Fix now. Gemini reads only short snippets, and every line it cites is re-checked against the real file. AI can raise a priority, never lower it."

**1:20 · The answer (40 s)**
`/overview`: point at the funnel: "All these alerts become the few to fix today." Click a Fix-now finding: reasons, the cited line of code, the verified upgrade command.
`/remediation`: "Every target version was re-checked. If there's no clean version, it says so."

**1:50 · Who can actually reach it? (optional, +20 s; use the kirana-billing upload)**
`/architecture`: "It also read the docker-compose file, the OpenAPI spec and our ARCHITECTURE.md. lodash is only used on the owner pages behind a JWT check, so it moves down one step; node-fetch only runs in a nightly job on a private network. Every claim quotes the file and line. And look: our own docs say `/supplier` needs login, but the code doesn't check. Vulnexis caught that."

**2:00 · Built for India (35 s)**
`/india`: verdict, next steps, CERT-In 6-hour rule, DPDP Section 8(5), each linked to the official source.
Flip **हिंदी**. Tap **Share on WhatsApp**.
> "The developer gets commands. The founder gets this, in Hindi, on WhatsApp."

**2:35 · Business case (25 s)**
> "Who pays: Indian startups at ₹999 a month, and dev agencies at ₹4,999 for 25 client apps. What they renew for: the weekly re-scan that WhatsApps them the day a package they use starts being exploited. First 100 users: free for college clubs and hackathons like this one, with a 'Scanned by Vulnexis' badge on every README."

**3:00 · Close**
> "Vulnexis. Security that speaks your language, for India's builders."

## Likely judge questions

- **"Isn't this just npm audit?"** npm audit lists. Vulnexis decides: exploitation data, production vs dev, whether *your code* calls the vulnerable function, a verified upgrade, Indian compliance mapping, and Hindi.
- **"What if the AI is wrong?"** It can't create or remove a finding. It can only raise a priority, and every citation is machine-checked against the file. "Not found" is shown as "needs review", not "safe".
- **"A vulnerable backend nobody can reach still shows up?"** It shows up, but lower. Vulnexis reads compose / Kubernetes / serverless / Procfile / OpenAPI / Markdown and the import graph: code only behind login, on a private network, in a cron job, or never loaded moves down one step (CISA SSVC "system exposure"). Never below Plan, never for known-exploited bugs, never when anyone can sign up. See [ARCHITECTURE_CONTEXT.md](ARCHITECTURE_CONTEXT.md).
- **"Where is the agent?"** `/agent`: the plan, tool calls, inputs, outputs, decisions and sources for this run. The plan changes with the inputs (no source → it skips the code check and says why).
- **"Limits?"** npm only, public repos only, top 30 direct findings get the code check, not legal advice.

## <a id="mlai"></a>How we used ML.ai (fill in honestly before judging)

The judges score "ML.ai implementation" (10 points) and want to be walked through how the ML.ai coding agent was used. Record only what the team actually did with ML.ai during the event, for example:

| What we built | How ML.ai helped | Prompt / session link |
| :--- | :--- | :--- |
| _e.g. GitHub tarball reader_ | _e.g. generated the tar parser, we reviewed and tested on NodeGoat_ | _link or screenshot_ |
| | | |

Show one ML.ai session on screen for ~20 seconds during the demo if time allows.
