import { effectiveTier, findingKey, type ReviewState } from './review'
import type { Finding, ScanResult } from '../types'

// India brief: turns findings into plain Hindi/English and into the two Indian rules a small team
// actually has to think about: CERT-In's 6-hour incident reporting and the DPDP Act's duty to protect
// personal data. Deterministic: every sentence is a template filled from scan data, so nothing here is
// AI-generated and nothing claims more than the data shows. Not legal advice.

export type Category = 'rce' | 'injection' | 'auth' | 'ssrf' | 'path' | 'leak' | 'xss' | 'proto' | 'dos' | 'other'

interface CategoryInfo {
  en: string
  hi: string
  // What an attacker could do, in words a shop owner or a first-year student understands.
  plainEn: string
  plainHi: string
  personalData: boolean // could plausibly expose or change personal data if exploited
}

export const CATEGORIES: Record<Category, CategoryInfo> = {
  rce: {
    en: 'Remote code execution',
    hi: 'सर्वर पर कोड चलाना',
    plainEn: 'An attacker could run their own commands on your server, as if they were logged in.',
    plainHi: 'हमलावर आपके सर्वर पर अपने कमांड चला सकता है, जैसे वह खुद लॉग-इन हो।',
    personalData: true,
  },
  injection: {
    en: 'Injection',
    hi: 'इंजेक्शन',
    plainEn: 'An attacker could make your database or app run their instructions and read or change records.',
    plainHi: 'हमलावर आपके डेटाबेस से अपनी बात मनवा कर रिकॉर्ड पढ़ या बदल सकता है।',
    personalData: true,
  },
  auth: {
    en: 'Login / signature bypass',
    hi: 'लॉग-इन या सिग्नेचर को चकमा',
    plainEn: 'An attacker could pretend to be another user or skip a security check.',
    plainHi: 'हमलावर किसी और यूज़र बनकर घुस सकता है या सुरक्षा जाँच को छोड़ सकता है।',
    personalData: true,
  },
  ssrf: {
    en: 'Server-side request forgery',
    hi: 'सर्वर से नकली रिक्वेस्ट',
    plainEn: 'An attacker could make your server fetch internal addresses it should never reach.',
    plainHi: 'हमलावर आपके सर्वर से अंदरूनी पते खुलवा सकता है जो बाहर से नहीं खुलने चाहिए।',
    personalData: true,
  },
  path: {
    en: 'File access',
    hi: 'फ़ाइलों तक पहुँच',
    plainEn: 'An attacker could read or write files on your server outside the allowed folder.',
    plainHi: 'हमलावर सर्वर पर अनुमति वाले फ़ोल्डर के बाहर की फ़ाइलें पढ़ या लिख सकता है।',
    personalData: true,
  },
  leak: {
    en: 'Information leak',
    hi: 'जानकारी लीक',
    plainEn: 'Private information such as headers, cookies or tokens could leak to someone else.',
    plainHi: 'हेडर, कुकी या टोकन जैसी निजी जानकारी किसी और तक पहुँच सकती है।',
    personalData: true,
  },
  xss: {
    en: 'Cross-site scripting',
    hi: 'वेबपेज में स्क्रिप्ट',
    plainEn: "An attacker could run a script inside your users' browsers and steal their session.",
    plainHi: 'हमलावर आपके यूज़र के ब्राउज़र में स्क्रिप्ट चला कर उनका सेशन चुरा सकता है।',
    personalData: true,
  },
  proto: {
    en: 'Prototype pollution',
    hi: 'ऑब्जेक्ट में छेड़छाड़',
    plainEn: "An attacker could change how your app's objects behave, which can open the door to bigger attacks.",
    plainHi: 'हमलावर आपके ऐप के अंदरूनी ऑब्जेक्ट बदल सकता है, जिससे बड़े हमले का रास्ता खुलता है।',
    personalData: false,
  },
  dos: {
    en: 'Denial of service',
    hi: 'सर्विस ठप',
    plainEn: 'An attacker could slow down or crash your app with a specially crafted request.',
    plainHi: 'हमलावर एक खास रिक्वेस्ट भेज कर आपका ऐप धीमा या बंद कर सकता है।',
    personalData: false,
  },
  other: {
    en: 'Security weakness',
    hi: 'सुरक्षा कमज़ोरी',
    plainEn: 'A published security weakness affects this version. Read the advisory before deciding.',
    plainHi: 'इस वर्ज़न में एक प्रकाशित सुरक्षा कमज़ोरी है। फ़ैसला लेने से पहले एडवाइज़री पढ़ें।',
    personalData: false,
  },
}

// Most specific first. The summary is tried before the long details text, which often mentions other classes.
const RULES: [Category, RegExp][] = [
  ['rce', /remote code execution|arbitrary code|code execution|command injection|code injection|template injection|os command|\brce\b/],
  ['injection', /sql injection|nosql injection|injection/],
  ['ssrf', /server-side request forgery|\bssrf\b/],
  ['path', /path traversal|directory traversal|arbitrary file|zip slip|file (read|write|overwrite)/],
  ['xss', /cross-site scripting|\bxss\b/],
  ['proto', /prototype pollution/],
  ['dos', /denial of service|\bredos\b|regular expression|\bdos\b|resource exhaustion|uncontrolled resource|infinite loop|unbounded|memory exhaustion/],
  ['auth', /authentication bypass|signature (validation|verification)|forgeable|forged? (token|signature)|impersonat|privilege escalation|legacy keys|improper verification/],
  ['leak', /leak|information (exposure|disclosure)|exposure of|disclos|secure headers|credential|open redirect/],
]

export function categorize(f: Finding): Category {
  for (const text of [f.advisory.summary, f.advisory.details]) {
    const t = (text ?? '').toLowerCase()
    const hit = RULES.find(([, re]) => re.test(t))
    if (hit) return hit[0]
  }
  return 'other'
}

export interface Obligation {
  id: 'certin' | 'certin-logs' | 'dpdp-safeguards' | 'dpdp-breach'
  lawEn: string
  lawHi: string
  ruleEn: string
  ruleHi: string
  whyEn: string // why it matters for THIS scan
  whyHi: string
  applies: 'now' | 'if-exploited' | 'ongoing'
  source: { label: string; url: string }
}

export type RiskLevel = 'critical' | 'high' | 'medium' | 'low'

export interface IndiaBrief {
  level: RiskLevel
  total: number
  fixNow: number
  kev: number
  production: number
  personalData: Finding[] // production findings whose category could expose personal data
  byCategory: { category: Category; count: number }[]
  obligations: Obligation[]
  summaryEn: string
  summaryHi: string
  steps: { en: string; hi: string }[]
}

const n = (x: number) => x.toLocaleString('en-IN')

export const SOURCES = {
  certin: { label: 'CERT-In Directions under Sec. 70B(6), IT Act (28 Apr 2022)', url: 'https://www.cert-in.org.in/PDF/CERT-In_Directions_70B_28.04.2022.pdf' },
  dpdp: { label: 'Digital Personal Data Protection Act, 2023 (MeitY)', url: 'https://www.meity.gov.in/data-protection-framework' },
}

export function buildIndiaBrief(result: ScanResult, review: ReviewState = {}): IndiaBrief {
  const fs = result.findings
  const tier = (f: Finding) => effectiveTier(f, review[findingKey(f)])
  const prod = fs.filter((f) => !f.pkg.dev)
  const fixNow = fs.filter((f) => tier(f) === 'FIX_NOW').length
  const kev = fs.filter((f) => f.enrichment.kev === true).length
  // Only urgent production findings count: a far-fetched Plan item should not sound like a data breach.
  const personalData = prod.filter((f) => CATEGORIES[categorize(f)].personalData && (tier(f) === 'FIX_NOW' || tier(f) === 'FIX_SPRINT'))

  const counts = new Map<Category, number>()
  for (const f of prod) counts.set(categorize(f), (counts.get(categorize(f)) ?? 0) + 1)
  const byCategory = [...counts.entries()].map(([category, count]) => ({ category, count })).sort((a, b) => b.count - a.count)

  const level: RiskLevel = kev > 0 || (fixNow > 0 && personalData.length > 0) ? 'critical' : fixNow > 0 ? 'high' : prod.some((f) => tier(f) === 'FIX_SPRINT') ? 'medium' : 'low'

  const obligations: Obligation[] = [
    {
      id: 'dpdp-safeguards',
      lawEn: 'DPDP Act 2023 · Section 8(5)',
      lawHi: 'DPDP अधिनियम 2023 · धारा 8(5)',
      ruleEn: 'If your app stores personal data of people in India, you must take reasonable security safeguards to prevent a breach. The Schedule allows penalties of up to ₹250 crore for failing this duty.',
      ruleHi: 'अगर आपका ऐप भारत के लोगों का निजी डेटा रखता है, तो ब्रीच रोकने के लिए उचित सुरक्षा उपाय करना ज़रूरी है। इसमें चूक पर ₹250 करोड़ तक का जुर्माना हो सकता है।',
      whyEn: personalData.length
        ? `${n(personalData.length)} production finding${personalData.length === 1 ? '' : 's'} could expose or change personal data. Known, fixable vulnerabilities left unpatched are hard to defend as "reasonable".`
        : 'No production finding in a data-exposing category. Keep dependencies patched to stay that way.',
      whyHi: personalData.length
        ? `${n(personalData.length)} प्रोडक्शन कमज़ोरियाँ निजी डेटा लीक या बदल सकती हैं। जानी-पहचानी, ठीक हो सकने वाली कमज़ोरियाँ छोड़ देना "उचित सुरक्षा" नहीं माना जाएगा।`
        : 'कोई भी प्रोडक्शन कमज़ोरी डेटा-लीक वाली श्रेणी में नहीं है। डिपेंडेंसी अपडेट रखें।',
      applies: personalData.length ? 'now' : 'ongoing',
      source: SOURCES.dpdp,
    },
    {
      id: 'certin',
      lawEn: 'CERT-In Directions 2022 · 6-hour reporting',
      lawHi: 'CERT-In निर्देश 2022 · 6 घंटे में रिपोर्ट',
      ruleEn: 'Service providers, intermediaries, data centres and companies must report listed cyber incidents (including attacks on servers and applications, unauthorised access and data breaches) to CERT-In within 6 hours of noticing them: incident@cert-in.org.in.',
      ruleHi: 'कंपनियों को तय साइबर घटनाएँ (सर्वर/ऐप पर हमला, अनधिकृत पहुँच, डेटा ब्रीच) पता चलने के 6 घंटे के अंदर CERT-In को बतानी होती हैं: incident@cert-in.org.in',
      whyEn: kev
        ? `${n(kev)} vulnerabilit${kev === 1 ? 'y is' : 'ies are'} on the CISA list of flaws already exploited in real attacks. If your logs show any sign of it being used against you, the 6-hour clock starts.`
        : 'Having a vulnerability is not itself an incident. Reporting starts only if you notice it being exploited, so patch before that happens.',
      whyHi: kev
        ? `${n(kev)} कमज़ोरी असली हमलों में पहले से इस्तेमाल हो चुकी है (CISA सूची)। अगर लॉग में इसके इस्तेमाल का कोई संकेत दिखे, तो 6 घंटे की घड़ी शुरू हो जाती है।`
        : 'सिर्फ़ कमज़ोरी होना "घटना" नहीं है। रिपोर्ट तभी करनी है जब इसका इस्तेमाल होता दिखे, इसलिए उससे पहले पैच करें।',
      applies: 'if-exploited',
      source: SOURCES.certin,
    },
    {
      id: 'certin-logs',
      lawEn: 'CERT-In Directions 2022 · logs for 180 days',
      lawHi: 'CERT-In निर्देश 2022 · 180 दिन तक लॉग',
      ruleEn: 'Keep logs of your ICT systems for 180 days, stored within India, and share them with CERT-In when asked.',
      ruleHi: 'अपने सिस्टम के लॉग 180 दिन तक भारत में ही सुरक्षित रखें और माँगने पर CERT-In को दें।',
      whyEn: 'Without logs you cannot tell whether the vulnerabilities above were ever exploited, or prove that they were not.',
      whyHi: 'लॉग के बिना आप यह न जान सकते हैं, न साबित कर सकते हैं कि ऊपर की कमज़ोरियों का इस्तेमाल हुआ या नहीं।',
      applies: 'ongoing',
      source: SOURCES.certin,
    },
    {
      id: 'dpdp-breach',
      lawEn: 'DPDP Act 2023 · Section 8(6)',
      lawHi: 'DPDP अधिनियम 2023 · धारा 8(6)',
      ruleEn: 'If a personal data breach happens, inform the Data Protection Board and every affected person.',
      ruleHi: 'अगर निजी डेटा का ब्रीच हो जाए, तो डेटा प्रोटेक्शन बोर्ड और हर प्रभावित व्यक्ति को सूचित करें।',
      whyEn: 'Applies only after a breach. Fixing the items above is how you avoid ever needing it.',
      whyHi: 'यह सिर्फ़ ब्रीच के बाद लागू होता है। ऊपर की चीज़ें ठीक करके आप इससे बच सकते हैं।',
      applies: 'if-exploited',
      source: SOURCES.dpdp,
    },
  ]

  const top = byCategory[0]
  const summaryEn =
    fs.length === 0
      ? `Good news: none of the ${n(result.packageCount)} packages has a known vulnerability today.`
      : `${n(result.packageCount)} packages checked. ${n(fs.length)} known vulnerabilities found, ${n(prod.length)} in code that runs in production. ` +
        (fixNow ? `${n(fixNow)} should be fixed today. ` : 'None needs an emergency fix. ') +
        (kev ? `${n(kev)} ${kev === 1 ? 'is' : 'are'} already used by attackers in the real world. ` : '') +
        (personalData.length ? `${n(personalData.length)} could expose your users' personal data, which matters under India's DPDP Act. ` : '') +
        (top ? `Most common problem: ${CATEGORIES[top.category].en.toLowerCase()}.` : '')
  const summaryHi =
    fs.length === 0
      ? `अच्छी ख़बर: ${n(result.packageCount)} पैकेज में आज कोई जानी-पहचानी कमज़ोरी नहीं है।`
      : `${n(result.packageCount)} पैकेज जाँचे। ${n(fs.length)} जानी-पहचानी कमज़ोरियाँ मिलीं, जिनमें से ${n(prod.length)} प्रोडक्शन कोड में हैं। ` +
        (fixNow ? `${n(fixNow)} आज ही ठीक करनी चाहिए। ` : 'किसी को तुरंत ठीक करने की ज़रूरत नहीं है। ') +
        (kev ? `${n(kev)} का असली हमलों में पहले से इस्तेमाल हो चुका है। ` : '') +
        (personalData.length ? `${n(personalData.length)} आपके यूज़र्स का निजी डेटा लीक कर सकती हैं, जो DPDP अधिनियम के तहत अहम है। ` : '') +
        (top ? `सबसे आम समस्या: ${CATEGORIES[top.category].hi}।` : '')

  const plans = result.plans.filter((p) => p.to)
  const steps: IndiaBrief['steps'] = []
  if (fixNow) steps.push({ en: `Fix the ${n(fixNow)} "Fix now" item${fixNow === 1 ? '' : 's'} today. The exact upgrade commands are on the Remediation page.`, hi: `${n(fixNow)} "अभी ठीक करें" वाली चीज़ें आज ही ठीक करें। अपग्रेड कमांड रेमेडिएशन पेज पर हैं।` })
  if (plans.length) steps.push({ en: `${n(plans.length)} package${plans.length === 1 ? ' has' : 's have'} a verified safe version. Upgrade, run your tests, deploy.`, hi: `${n(plans.length)} पैकेज का सुरक्षित वर्ज़न जाँचा जा चुका है। अपग्रेड करें, टेस्ट चलाएँ, डिप्लॉय करें।` })
  steps.push({ en: 'Check that server logs are kept for 180 days, in India (CERT-In).', hi: 'देखें कि सर्वर लॉग 180 दिन तक भारत में रखे जा रहे हैं (CERT-In)।' })
  if (kev) steps.push({ en: 'Search your logs for signs of the exploited vulnerabilities. If you find any, report to CERT-In within 6 hours.', hi: 'लॉग में इन कमज़ोरियों के इस्तेमाल के संकेत खोजें। कुछ मिले तो 6 घंटे में CERT-In को रिपोर्ट करें।' })
  steps.push({ en: 'Scan again after upgrading, and compare on the Reports page.', hi: 'अपग्रेड के बाद दोबारा स्कैन करें और रिपोर्ट पेज पर तुलना करें।' })

  return { level, total: fs.length, fixNow, kev, production: prod.length, personalData, byCategory, obligations, summaryEn, summaryHi, steps }
}

/** Short text for WhatsApp: what a developer sends to the founder or client. */
export function whatsappText(brief: IndiaBrief, project: string, lang: 'en' | 'hi'): string {
  const lines =
    lang === 'hi'
      ? [`*Kavach सुरक्षा रिपोर्ट: ${project}*`, '', brief.summaryHi, '', '*अगले कदम*', ...brief.steps.map((s, i) => `${i + 1}. ${s.hi}`)]
      : [`*Kavach security report: ${project}*`, '', brief.summaryEn, '', '*Next steps*', ...brief.steps.map((s, i) => `${i + 1}. ${s.en}`)]
  lines.push('', lang === 'hi' ? '_सूचना के लिए, क़ानूनी सलाह नहीं।_' : '_For information, not legal advice._')
  return lines.join('\n')
}
