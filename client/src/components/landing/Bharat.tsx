import { useLang } from '../../lib/i18n'
import { Link } from '../../router'
import { Icon, type IconName } from '../ui/Icon'
import { SectionHead } from './SectionHead'
import { useOpenDemo } from './useOpenDemo'

// Landing sections added for Kavach: the agent loop, why it is built for India, and pricing in rupees.

const LOOP: { icon: IconName; en: string; hi: string; dEn: string; dHi: string; ai?: boolean }[] = [
  { icon: 'github', en: 'Take a real input', hi: 'असली इनपुट', dEn: 'A GitHub link or a lockfile. No login.', dHi: 'पब्लिक GitHub लिंक या package-lock.json। न लॉग-इन, न निजी जानकारी।' },
  { icon: 'bot', en: 'Plan', hi: 'योजना', dEn: 'Picks the tools this run needs, and says why.', dHi: 'आपके दिए इनपुट से तय करता है कि कौन-से टूल चाहिए, और क्यों।' },
  { icon: 'search', en: 'Call tools', hi: 'टूल चलाना', dEn: 'OSV.dev, EPSS, CISA KEV and npm.', dHi: 'तथ्यों के लिए OSV.dev, असली हमलों के लिए EPSS और CISA KEV, वर्ज़न के लिए npm।' },
  { icon: 'sparkle', en: 'Read your code', hi: 'कोड पढ़ना', dEn: 'Does your code call the vulnerable function?', dHi: 'Gemini देखता है कि आपका कोड कमज़ोर फ़ंक्शन चलाता है या नहीं। हर उद्धरण दोबारा जाँचा जाता है।', ai: true },
  { icon: 'shield-check', en: 'Verify the fix', hi: 'सुधार पक्का करना', dEn: 'Every upgrade target is re-checked.', dHi: 'हर अपग्रेड वर्ज़न को दोबारा जाँचता है ताकि नया वर्ज़न भी कमज़ोर न निकले।' },
  { icon: 'message', en: 'Answer in your language', hi: 'आपकी भाषा में जवाब', dEn: 'Commands, a CERT-In/DPDP brief, WhatsApp in Hindi.', dHi: 'सुधार का क्रम, सटीक कमांड, CERT-In / DPDP रिपोर्ट और हिंदी या अंग्रेज़ी में WhatsApp सारांश।' },
]

export function AgentSection() {
  const { tr } = useLang()
  return (
    <section id="agent" className="lp-section" aria-labelledby="agent-title">
      <div className="lp-wrap">
        <SectionHead
          id="agent-title"
          eyebrow={tr('An agent, not a chatbot', 'एजेंट, चैटबॉट नहीं')}
          title={tr('It plans, calls tools, decides, and shows its work.', 'यह योजना बनाता है, टूल चलाता है, फ़ैसला लेता है, और सब दिखाता है।')}
          lede={tr(
            'Every step streams live to your screen: the tool it called, what went in, what came back, the decision it took and the source behind it. When it does not know, it says so.',
            'हर कदम लाइव दिखता है: कौन-सा टूल चला, क्या गया, क्या मिला, क्या फ़ैसला हुआ और उसका स्रोत। जब पता न हो, तो साफ़ कहता है।',
          )}
        />
        <div className="kv-agent">
          <ol className="kv-loop">
            {LOOP.map((s, i) => (
              <li key={s.en} className={s.ai ? 'kv-loop__ai' : undefined}>
                <span className="kv-loop__n num">{String(i + 1).padStart(2, '0')}</span>
                <span className="kv-loop__icon" aria-hidden="true">
                  <Icon name={s.icon} size={16} />
                </span>
                <h3>{tr(s.en, s.hi)}</h3>
                <p>{tr(s.dEn, s.dHi)}</p>
              </li>
            ))}
          </ol>
          <figure className="kv-trace" aria-label={tr('Excerpt of a real agent trace', 'असली एजेंट ट्रेस का अंश')}>
            <figcaption>
              <span className="kv-trace__dot" aria-hidden="true" />
              agent · OWASP/NodeGoat
            </figcaption>
            <pre>
              <span className="kv-t-tool">[fetch]</span> read OWASP/NodeGoat · package-lock.json + 44 files{'\n'}
              <span className="kv-t-tool">[plan]</span> source available → <span className="kv-t-dec">will check code usage</span>
              {'\n'}
              <span className="kv-t-tool">[osv]</span> 1,480 packages → known vulnerabilities matched{'\n'}
              <span className="kv-t-tool">[kev]</span> exploited in the wild → <span className="kv-t-dec">straight to Fix now</span>
              {'\n'}
              <span className="kv-t-ai">[gemini]</span> citations re-checked against real files{'\n'}
              <span className="kv-t-tool">[verify]</span> no clean version? → <span className="kv-t-dec">say so, never guess</span>
              {'\n'}
              <span className="kv-t-tool">[report]</span> हिंदी + English · CERT-In · DPDP
            </pre>
            <Link to="/scan" className="btn btn--primary btn--sm">
              <Icon name="bot" size={14} />
              {tr('Watch it run live', 'लाइव चलते देखें')}
            </Link>
          </figure>
        </div>
      </div>
    </section>
  )
}

export function IndiaSection() {
  const { tr } = useLang()
  const cards: { icon: IconName; en: string; hi: string; dEn: string; dHi: string; src?: string }[] = [
    {
      icon: 'scale',
      en: 'DPDP Act: up to ₹250 crore',
      hi: 'DPDP अधिनियम: ₹250 करोड़ तक',
      dEn: 'Section 8(5): reasonable safeguards for personal data. Known, unpatched bugs are hard to defend.',
      dHi: 'भारतीयों का निजी डेटा रखने वाले ऐप को उचित सुरक्षा उपाय करने होते हैं (धारा 8(5))। जानी-पहचानी कमज़ोरियाँ छोड़ना मुश्किल में डाल सकता है।',
      src: 'https://www.meity.gov.in/data-protection-framework',
    },
    {
      icon: 'clock',
      en: 'CERT-In: report within 6 hours',
      hi: 'CERT-In: 6 घंटे में रिपोर्ट',
      dEn: 'Report attacks within 6 hours; keep logs 180 days in India.',
      dHi: 'सर्वर या ऐप पर हमले की सूचना 6 घंटे में CERT-In को देनी होती है, और लॉग 180 दिन भारत में रखने होते हैं। Kavach बताता है कि किस पर नज़र रखें।',
      src: 'https://www.cert-in.org.in/PDF/CERT-In_Directions_70B_28.04.2022.pdf',
    },
    {
      icon: 'message',
      en: 'Hindi for the founder, commands for the dev',
      hi: 'फ़ाउंडर के लिए हिंदी, डेवलपर के लिए कमांड',
      dEn: 'Commands for the developer; a plain summary on WhatsApp for the founder.',
      dHi: 'डेवलपर को सटीक अपग्रेड कमांड मिलते हैं। फ़ाउंडर या क्लाइंट को एक टैप में WhatsApp पर आसान हिंदी या अंग्रेज़ी सारांश।',
    },
    {
      icon: 'globe',
      en: 'Works on a ₹8,000 phone',
      hi: '₹8,000 के फ़ोन पर भी चलता है',
      dEn: 'Paste a link in a phone browser. No install, no account.',
      dHi: 'फ़ोन ब्राउज़र से GitHub लिंक डालें। न इंस्टॉल, न अकाउंट, न अपलोड। हल्का UI, बड़े बटन।',
    },
  ]
  return (
    <section id="india" className="lp-section kv-india" aria-labelledby="india-title">
      <div className="lp-wrap">
        <SectionHead
          id="india-title"
          eyebrow={tr('Built for India', 'भारत के लिए बना')}
          title={tr(
            'Indian startups ship fast on open source. Almost none have a security team.',
            'भारतीय स्टार्टअप ओपन-सोर्स पर तेज़ी से बनाते हैं। सुरक्षा टीम लगभग किसी के पास नहीं।',
          )}
          lede={tr(
            'Student teams, two-person startups and small agencies building for clients run hundreds of npm packages. Since the DPDP Act and CERT-In’s 2022 directions, "we did not know" is no longer a safe answer.',
            'कॉलेज टीमें, दो लोगों के स्टार्टअप और क्लाइंट के लिए काम करने वाली एजेंसियाँ सैकड़ों npm पैकेज चलाती हैं। DPDP अधिनियम और CERT-In निर्देशों के बाद "हमें पता नहीं था" अब सुरक्षित जवाब नहीं है।',
          )}
        />
        <ul className="kv-cards">
          {cards.map((c) => (
            <li key={c.en} className="kv-card">
              <h3 className="kv-card__head">
                <Icon name={c.icon} size={18} />
                <span>{tr(c.en, c.hi)}</span>
              </h3>
              <p>{tr(c.dEn, c.dHi)}</p>
              {c.src && (
                <a href={c.src} target="_blank" rel="noreferrer noopener" className="kv-card__src">
                  <Icon name="external" size={11} />
                  {tr('Official source', 'आधिकारिक स्रोत')}
                </a>
              )}
            </li>
          ))}
        </ul>
        <p className="kv-fine">{tr('Kavach gives information, not legal advice.', 'Kavach जानकारी देता है, क़ानूनी सलाह नहीं।')}</p>
      </div>
    </section>
  )
}

const PLANS = [
  {
    nameEn: 'Student & open source',
    nameHi: 'स्टूडेंट और ओपन-सोर्स',
    price: '₹0',
    perEn: 'forever',
    perHi: 'हमेशा',
    forEn: 'College teams, hackathon projects, public repos',
    forHi: 'कॉलेज टीमें, हैकाथॉन प्रोजेक्ट, पब्लिक रिपॉज़िटरी',
    features: [
      ['10 scans a month', 'महीने में 10 स्कैन'],
      ['Agent trace, fix plan, commands', 'एजेंट ट्रेस, सुधार योजना, कमांड'],
      ['Hindi + English report', 'हिंदी + अंग्रेज़ी रिपोर्ट'],
    ],
  },
  {
    nameEn: 'Startup',
    nameHi: 'स्टार्टअप',
    price: '₹999',
    perEn: 'per month',
    perHi: 'प्रति माह',
    forEn: 'Seed-stage teams with one or two products',
    forHi: 'एक-दो प्रोडक्ट वाली शुरुआती टीमें',
    featured: true,
    features: [
      ['Unlimited scans, private repos', 'अनलिमिटेड स्कैन, प्राइवेट रिपॉज़िटरी'],
      ['Weekly re-scan + WhatsApp alert on new exploited CVEs', 'हर हफ़्ते स्कैन + नए ख़तरे पर WhatsApp अलर्ट'],
      ['CERT-In / DPDP brief as PDF for investors', 'निवेशकों के लिए CERT-In / DPDP रिपोर्ट PDF'],
    ],
  },
  {
    nameEn: 'Agency',
    nameHi: 'एजेंसी',
    price: '₹4,999',
    perEn: 'per month',
    perHi: 'प्रति माह',
    forEn: 'Dev shops maintaining client apps',
    forHi: 'क्लाइंट ऐप सँभालने वाली डेव एजेंसियाँ',
    features: [
      ['25 client projects', '25 क्लाइंट प्रोजेक्ट'],
      ['White-label report in the client’s language', 'क्लाइंट की भाषा में अपने ब्रांड वाली रिपोर्ट'],
      ['Before/after proof for maintenance retainers', 'मेंटेनेंस कॉन्ट्रैक्ट के लिए पहले/बाद का सबूत'],
    ],
  },
]

export function Pricing() {
  const { tr } = useLang()
  const openDemo = useOpenDemo()
  return (
    <section id="pricing" className="lp-section" aria-labelledby="pricing-title">
      <div className="lp-wrap">
        <SectionHead
          id="pricing-title"
          eyebrow={tr('Pricing in rupees', 'क़ीमत रुपये में')}
          title={tr('Cheaper than one hour of a security consultant.', 'एक घंटे के सिक्योरिटी कंसल्टेंट से भी सस्ता।')}
          lede={tr(
            'Who pays: Indian startups and the dev agencies that build for Indian SMEs. What they renew for: the weekly re-scan that pings them on WhatsApp the day a package they use starts being exploited.',
            'कौन देगा: भारतीय स्टार्टअप और SME के लिए ऐप बनाने वाली एजेंसियाँ। किस लिए रिन्यू करेंगे: हर हफ़्ते का स्कैन, जो उसी दिन WhatsApp करता है जिस दिन उनके किसी पैकेज पर हमले शुरू हों।',
          )}
        />
        <ul className="kv-plans">
          {PLANS.map((p) => (
            <li key={p.nameEn} className={`kv-plan${p.featured ? ' kv-plan--featured' : ''}`}>
              {p.featured && <span className="kv-plan__tag">{tr('Most teams', 'सबसे लोकप्रिय')}</span>}
              <h3>{tr(p.nameEn, p.nameHi)}</h3>
              <p className="kv-plan__for">{tr(p.forEn, p.forHi)}</p>
              <p className="kv-plan__price">
                <span className="num">{p.price}</span> <span className="subtle">{tr(p.perEn, p.perHi)}</span>
              </p>
              <ul>
                {p.features.map(([en, hi]) => (
                  <li key={en}>
                    <Icon name="check" size={14} />
                    {tr(en, hi)}
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
        <div className="kv-gtm">
          <div>
            <h3>{tr('First 100 users, for almost ₹0', 'पहले 100 यूज़र, लगभग ₹0 में')}</h3>
            <ol>
              <li>{tr('College tech clubs and hackathons (Geek Room, GDG chapters): free tier + "Scanned by Kavach" README badge.', 'कॉलेज टेक क्लब और हैकाथॉन (Geek Room, GDG): फ़्री प्लान + README पर "Scanned by Kavach" बैज।')}</li>
              <li>{tr('Open a helpful PR on popular Indian open-source repos with their fix plan.', 'लोकप्रिय भारतीय ओपन-सोर्स रिपॉज़िटरी पर उनकी सुधार योजना के साथ PR।')}</li>
              <li>{tr('Dev agencies on LinkedIn: one free client report, then the Agency plan.', 'LinkedIn पर डेव एजेंसियाँ: एक फ़्री क्लाइंट रिपोर्ट, फिर एजेंसी प्लान।')}</li>
            </ol>
          </div>
          <div className="kv-gtm__cta">
            <Link to="/scan" className="btn btn--primary">
              <Icon name="github" size={14} />
              {tr('Scan your repo free', 'अपनी रिपॉज़िटरी फ़्री स्कैन करें')}
            </Link>
            <button type="button" className="btn" onClick={openDemo}>
              <Icon name="beaker" size={14} />
              {tr('See a demo report', 'डेमो रिपोर्ट देखें')}
            </button>
          </div>
        </div>
      </div>
    </section>
  )
}
