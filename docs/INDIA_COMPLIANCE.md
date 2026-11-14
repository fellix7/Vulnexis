# India brief: compliance mapping and plain-language logic

The India brief (`/india`) turns a scan into two things an Indian team needs: a **plain Hindi or English explanation** a non-developer can act on, and the **Indian rules** that the findings touch. It is built by one pure function, `buildIndiaBrief(result, review)` in `client/src/lib/india.ts`.

> **Not legal advice.** The brief gives information with links to official sources. Teams should confirm their obligations with a qualified professional.

## 1. Why deterministic, not AI

The brief talks about the law. A generated sentence that overstated an obligation could mislead a founder. So every sentence is a fixed template in both languages, filled only with numbers from the scan. The same scan always produces the same brief, and every claim can be traced back to a finding.

## 2. Risk categories

Each finding is put into one category by matching the advisory **summary first** and then the details (the details often mention other bug classes in passing). The rules are checked in order, most specific first:

| Order | Category | Matches (lower-case) | Could expose personal data? |
| :--- | :--- | :--- | :--- |
| 1 | Remote code execution (सर्वर पर कोड चलाना) | remote code execution, arbitrary code, code execution, command/code/template injection, os command, rce | Yes |
| 2 | Injection (इंजेक्शन) | sql injection, nosql injection, injection | Yes |
| 3 | Server-side request forgery (सर्वर से नकली रिक्वेस्ट) | server-side request forgery, ssrf | Yes |
| 4 | File access (फ़ाइलों तक पहुँच) | path/directory traversal, arbitrary file, zip slip, file read/write/overwrite | Yes |
| 5 | Cross-site scripting (वेबपेज में स्क्रिप्ट) | cross-site scripting, xss | Yes |
| 6 | Prototype pollution (ऑब्जेक्ट में छेड़छाड़) | prototype pollution | No |
| 7 | Denial of service (सर्विस ठप) | denial of service, redos, regular expression, dos, resource/memory exhaustion, unbounded, infinite loop | No |
| 8 | Login / signature bypass (लॉग-इन या सिग्नेचर को चकमा) | authentication bypass, signature validation/verification, forgeable, forged token/signature, impersonat, privilege escalation, legacy keys, improper verification | Yes |
| 9 | Information leak (जानकारी लीक) | leak, information exposure/disclosure, exposure of, disclos, secure headers, credential, open redirect | Yes |
| – | Security weakness (सुरक्षा कमज़ोरी) | anything else | No |

Each category has a one-sentence plain explanation in both languages, for example:

- **EN:** "An attacker could run their own commands on your server, as if they were logged in."
- **HI:** "हमलावर आपके सर्वर पर अपने कमांड चला सकता है, जैसे वह खुद लॉग-इन हो।"

## 3. Counts used by the brief

| Value | Definition |
| :--- | :--- |
| `fixNow` | Findings whose effective tier (after human review) is Fix now |
| `kev` | Findings on the CISA Known Exploited Vulnerabilities list |
| `production` | Findings in non-dev dependencies |
| `personalData` | **Production** findings in a "could expose personal data" category **and** in Fix now or Fix this sprint. Plan/Monitor items are left out so a remote edge case does not read like a data breach |
| `byCategory` | Production findings counted per category, largest first |

## 4. Verdict

| Level | Rule | Shown as (EN / HI) |
| :--- | :--- | :--- |
| critical | any KEV finding, **or** (Fix now > 0 **and** personal-data findings > 0) | Act today / आज ही कदम उठाएँ |
| high | Fix now > 0 | Fix this week / इस हफ़्ते ठीक करें |
| medium | any production finding in Fix this sprint | Plan the fixes / सुधार की योजना बनाएँ |
| low | otherwise | In good shape / स्थिति ठीक है |

## 5. Obligations

Each obligation shows the rule, **why it matters for this scan**, when it applies, and the official source.

| Obligation | Rule (summary) | Applies | Scan-specific reason |
| :--- | :--- | :--- | :--- |
| **DPDP Act 2023, Section 8(5)** | A data fiduciary must protect personal data in its possession with reasonable security safeguards to prevent a breach. The Schedule allows penalties of up to ₹250 crore for failing this duty. | **Now** if personal-data findings > 0, else **Always** | "N production findings could expose or change personal data. Known, fixable vulnerabilities left unpatched are hard to defend as reasonable." |
| **CERT-In Directions (28 April 2022), 6-hour reporting** | Service providers, intermediaries, data centres, body corporates and government organisations must report listed cyber incidents (including attacks on servers and applications, unauthorised access, data breaches) to CERT-In within 6 hours of noticing them. Contact: incident@cert-in.org.in. | **If exploited** | With KEV findings: "If your logs show any sign of it being used against you, the 6-hour clock starts." Without: "Having a vulnerability is not itself an incident." |
| **CERT-In Directions, logs** | Keep ICT system logs for 180 days within India, and provide them to CERT-In on request. | **Always** | "Without logs you cannot tell whether the vulnerabilities above were ever exploited, or prove that they were not." |
| **DPDP Act 2023, Section 8(6)** | On a personal data breach, inform the Data Protection Board and each affected person. | **If exploited** | "Applies only after a breach. Fixing the items above is how you avoid ever needing it." |

Sources linked in the UI:
- CERT-In Directions under Section 70B(6) of the IT Act: https://www.cert-in.org.in/PDF/CERT-In_Directions_70B_28.04.2022.pdf
- DPDP Act 2023 (MeitY data protection framework): https://www.meity.gov.in/data-protection-framework

The DPDP Rules, 2025 were notified on 13 November 2025, with obligations coming into force in phases. The brief cites the Act's sections, which are stable, rather than rule-level timelines. Re-check this when the phases change.

## 6. Next steps (generated in order)

1. If Fix now > 0: "Fix the N 'Fix now' items today. The exact upgrade commands are on the Remediation page."
2. If any verified plans: "N packages have a verified safe version. Upgrade, run your tests, deploy."
3. Always: "Check that server logs are kept for 180 days, in India (CERT-In)."
4. If KEV > 0: "Search your logs for signs of the exploited vulnerabilities. If you find any, report to CERT-In within 6 hours."
5. Always: "Scan again after upgrading, and compare on the Reports page."

Each step exists in Hindi too.

## 7. Summary and WhatsApp message

The summary is built from the counts: packages checked, findings, production findings, Fix-now count, KEV count, personal-data count, and the most common category. The WhatsApp message (`whatsappText`) is:

```
*Kavach security report: <project>*

<summary in the chosen language>

*Next steps*
1. …
2. …

_For information, not legal advice._
```

It is opened with `https://wa.me/?text=<encoded message>`. The user picks the recipient inside WhatsApp; Kavach never sees a phone number.

## 8. Worked example (bundled sample)

251 packages · 76 findings · 56 production · 3 Fix now · 0 KEV.

- Verdict: **Act today** (Fix now > 0 and personal-data findings > 0).
- Most common production category: denial of service.
- DPDP 8(5): **Applies now**, because some Fix now / Fix this sprint findings fall in data-exposing categories (injection, SSRF, code execution, information leak).
- CERT-In reporting: **If exploited**, with the "not itself an incident" explanation, since nothing is on KEV.

## 9. Changing the mapping

- Category regexes and texts: `RULES` and `CATEGORIES` in `client/src/lib/india.ts`.
- Obligations and their wording: `buildIndiaBrief` › `obligations`.
- Update this document and [SYSTEM_POLICIES.md › 9](SYSTEM_POLICIES.md#9-regulatory-information-policy) in the same commit.
