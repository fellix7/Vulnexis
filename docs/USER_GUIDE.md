# Kavach user guide · उपयोग गाइड

Kavach tells you which vulnerable open-source packages in your Node.js project to fix first, why, and how, in Hindi or English.
Kavach बताता है कि आपके Node.js प्रोजेक्ट के कौन-से कमज़ोर ओपन-सोर्स पैकेज पहले ठीक करने हैं, क्यों, और कैसे, हिंदी या अंग्रेज़ी में।

**You never need to give personal information.** No login, no phone number, no Aadhaar or PAN.
**आपको कोई निजी जानकारी नहीं देनी है।** न लॉग-इन, न फ़ोन नंबर, न आधार या PAN।

---

## 1. Choose your language · भाषा चुनें

Use the **EN | हिंदी** switch at the top right of every page. Kavach remembers your choice in this browser.
हर पेज पर ऊपर दाईं ओर **EN | हिंदी** बटन से भाषा बदलें। आपकी पसंद इस ब्राउज़र में याद रहती है।

## 2. Start a scan · स्कैन शुरू करें (`/scan`)

### Option A: GitHub link (best on a phone) · GitHub लिंक (फ़ोन पर सबसे आसान)
1. Paste your public repository link, for example `https://github.com/owner/repo`.
   अपनी पब्लिक रिपॉज़िटरी का लिंक डालें।
2. Tap **Run agent / एजेंट चलाएँ**. Or tap an example: **OWASP/NodeGoat**, **snyk-labs/nodejs-goof**.
3. The repository must contain an npm `package-lock.json`.
   रिपॉज़िटरी में npm `package-lock.json` होना चाहिए।

### Option B: Upload files · फ़ाइल अपलोड करें
1. **Lockfile (required):** drop your `package-lock.json` (npm 7 or newer).
2. **Source folder (optional):** choose your project folder so the AI can check whether your code really calls the vulnerable function. Only JS/TS files are read (≤ 300 files, 3 MB).
3. Press **Run scan / स्कैन शुरू करें**.

### Option C: No project? · कोई प्रोजेक्ट नहीं?
- **Scan the sample project:** a real scan of QuickNotes, a deliberately outdated demo app.
- **Explore demo data:** instant illustrative results, labelled "Demo data" and never saved.

## 3. Watch the agent work · एजेंट को काम करते देखें

While scanning, a live timeline shows each step. Every step shows:
स्कैन के दौरान हर कदम लाइव दिखता है:

| Part · हिस्सा | Meaning · मतलब |
| :--- | :--- |
| Tool chip (e.g. OSV.dev, Gemini) · टूल | What the agent used · एजेंट ने क्या इस्तेमाल किया |
| IN / इनपुट | What went into the tool · टूल में क्या गया |
| OUT / नतीजा | What came back · क्या मिला |
| Decision / फ़ैसला | What it decided next, and why · आगे क्या तय किया, और क्यों |
| Source link · स्रोत | Where the fact came from · तथ्य कहाँ से आया |

A violet dashed chip means AI. Everything else is data or fixed rules.
बैंगनी डैश वाला चिप AI है। बाक़ी सब डेटा या तय नियम हैं।

After the scan, open **Agent trace / एजेंट का काम** in the sidebar to see the full run again.

## 4. Read the results · नतीजे समझें

### Overview · सारांश (`/overview`)
The funnel: all known vulnerabilities → those in production code → those your code actually calls → **Fix now**.

### Priorities · प्राथमिकता

| Tier | Meaning | What to do |
| :--- | :--- | :--- |
| 🔴 **Fix now** · अभी ठीक करें | Exploited in real attacks, or high/critical in production with high exploit probability or confirmed use by your code | Today · आज |
| 🟠 **Fix this sprint** | Other high/critical production issues | This week or sprint |
| 🔵 **Plan** | Other production issues | Add to backlog |
| ⚪ **Monitor** | Development-only packages | Keep an eye on it |

### Findings · कमज़ोरियाँ (`/findings`)
Filter by tier, severity, production/dev, direct/transitive, AI verdict or KEV. Search by package or CVE. Open any finding for:
- **Why this priority:** the exact reasons.
- **Advisory:** the original text (shown as plain text).
- **Dependency chain:** which of your packages pulls it in.
- **Code evidence:** the AI verdict with the cited line of your code (citations are machine-checked).
- **Fix:** the verified upgrade and command.
- **Review:** confirm or dispute the AI verdict; lower a priority if you know better (not allowed for actively exploited ones).

### Code evidence · कोड सबूत (`/evidence`)
Every place where your code reaches a vulnerable function, with the verified file and line.

### Remediation · सुधार (`/remediation`)
The smallest safe version for each package, re-checked so the upgrade does not land on another vulnerable version, with a copy-ready command such as:

```bash
npm install ejs@3.1.10
```

For packages you did not install directly, Kavach names the parent package to upgrade, or gives an npm `overrides` command.

## 5. India brief · भारत रिपोर्ट (`/india`)

- **Verdict · नतीजा:** Act today / Fix this week / Plan the fixes / In good shape.
- **Summary** in your language, with **Show in Hindi too** to see both.
- **Do this next · अब यह करें:** a short numbered list.
- **What kind of risk · किस तरह का ख़तरा:** risks grouped in plain words; "personal data" marks those that could expose user data.
- **Indian rules that apply · लागू होने वाले भारतीय नियम:** DPDP Act Sections 8(5) and 8(6), CERT-In 6-hour reporting and 180-day logs, each with "Applies now / If exploited / Always" and a link to the official source.
- **In plain words · आसान शब्दों में:** the most urgent findings explained without jargon.
- **Share on WhatsApp · WhatsApp पर भेजें:** opens WhatsApp with a ready summary for your founder or client. You choose who to send it to.

This is information, not legal advice. यह जानकारी है, क़ानूनी सलाह नहीं।

## 6. Reports and history · रिपोर्ट व इतिहास (`/reports`)

- Download the report as **Markdown** or **JSON**.
- Your last 8 scans are saved **in this browser only**. Open, delete or clear them at any time.
- **Compare** two scans to see what your upgrades fixed.

## 7. Questions · सवाल

**Does Kavach run my code? · क्या Kavach मेरा कोड चलाता है?**
No. It only reads files as text. नहीं, सिर्फ़ टेक्स्ट की तरह पढ़ता है।

**What does the AI see? · AI क्या देखता है?**
Only short snippets of your code around imports of vulnerable packages, with secrets masked. सिर्फ़ कमज़ोर पैकेज के आस-पास के छोटे हिस्से, पासवर्ड/की छिपाकर।

**"Not assessed" means safe? · "Not assessed" का मतलब सुरक्षित?**
No. It means the code check did not review that finding. नहीं, इसका मतलब है कि उसकी जाँच नहीं हुई।

**Private repositories? · प्राइवेट रिपॉज़िटरी?**
Not by link. Upload the lockfile and source folder instead. लिंक से नहीं; फ़ाइल अपलोड करें।

**Yarn or pnpm?**
Not yet. Generate an npm lockfile with `npm install --package-lock-only`.
