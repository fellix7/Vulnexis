import { useLang } from '../../lib/i18n'
import { Link } from '../../router'
import { Icon, type IconName } from '../ui/Icon'
import { SectionHead } from './SectionHead'
import { useOpenDemo } from './useOpenDemo'

// Landing sections added for Vulnexis: the agent loop, why it is built for India, and pricing in rupees.

const LOOP: { icon: IconName; en: string; hi: string; dEn: string; dHi: string; ai?: boolean }[] = [
  { icon: 'github', en: 'Take a real input', hi: 'असली इनपुट', dEn: 'A GitHub link or a lockfile. No login.', dHi: 'GitHub लिंक या लॉकफ़ाइल। लॉग-इन नहीं।' },
  { icon: 'bot', en: 'Plan', hi: 'योजना', dEn: 'Picks the tools this run needs.', dHi: 'तय करता है कि कौन-से टूल चाहिए।' },
  { icon: 'search', en: 'Call tools', hi: 'टूल चलाना', dEn: 'OSV.dev, EPSS, CISA KEV and npm.', dHi: 'OSV.dev, EPSS, CISA KEV और npm।' },
  { icon: 'sparkle', en: 'Read your code', hi: 'कोड पढ़ना', dEn: 'Does your code call the vulnerable function?', dHi: 'क्या आपका कोड कमज़ोर फ़ंक्शन चलाता है?', ai: true },
  { icon: 'shield-check', en: 'Verify the fix', hi: 'सुधार पक्का करना', dEn: 'Every upgrade is re-checked.', dHi: 'हर अपग्रेड दोबारा जाँचा जाता है।' },
  { icon: 'message', en: 'Answer in your language', hi: 'आपकी भाषा में जवाब', dEn: 'Commands, a CERT-In brief, Hindi on WhatsApp.', dHi: 'कमांड, CERT-In रिपोर्ट, WhatsApp पर हिंदी।' },
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
      dEn: 'Section 8(5) asks for reasonable safeguards.',
      dHi: 'धारा 8(5): उचित सुरक्षा उपाय ज़रूरी।',
      src: 'https://www.meity.gov.in/data-protection-framework',
    },
    {
      icon: 'clock',
      en: 'CERT-In: report within 6 hours',
      hi: 'CERT-In: 6 घंटे में रिपोर्ट',
      dEn: 'Keep logs for 180 days in India.',
      dHi: 'लॉग 180 दिन भारत में रखें।',
      src: 'https://www.cert-in.org.in/PDF/CERT-In_Directions_70B_28.04.2022.pdf',
    },
    {
      icon: 'message',
      en: 'Hindi for the founder, commands for the dev',
      hi: 'फ़ाउंडर के लिए हिंदी, डेवलपर के लिए कमांड',
      dEn: 'A plain summary on WhatsApp.',
      dHi: 'WhatsApp पर आसान सारांश।',
    },
    {
      icon: 'globe',
      en: 'Works on a ₹8,000 phone',
      hi: '₹8,000 के फ़ोन पर भी चलता है',
      dEn: 'No install, no account.',
      dHi: 'न इंस्टॉल, न अकाउंट।',
    },
  ]
  return (
    <section id="india" className="lp-section kv-india" aria-labelledby="india-title">
      <div className="lp-wrap">
        <SectionHead
          id="india-title"
          eyebrow={tr('Built for India', 'भारत के लिए बना')}
          title={tr('Built for Indian teams without a security team.', 'बिना सुरक्षा टीम वाली भारतीय टीमों के लिए।')}
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
        <p className="kv-fine">{tr('Vulnera gives information, not legal advice.', 'Vulnera जानकारी देता है, क़ानूनी सलाह नहीं।')}</p>
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
          <h3>{tr('Free for college clubs and hackathons.', 'कॉलेज क्लब और हैकाथॉन के लिए फ़्री।')}</h3>
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
