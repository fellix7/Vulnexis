import { useLang } from '../../lib/i18n'
import { Link } from '../../router'
import { Icon, type IconName } from '../ui/Icon'
import { SectionHead } from './SectionHead'

// Landing section: the agent loop.

const LOOP: { icon: IconName; en: string; hi: string; dEn: string; dHi: string; ai?: boolean }[] = [
  { icon: 'github', en: 'Take a real input', hi: 'असली इनपुट', dEn: 'A GitHub link or a lockfile. No login.', dHi: 'GitHub लिंक या लॉकफ़ाइल। लॉग-इन नहीं।' },
  { icon: 'bot', en: 'Plan', hi: 'योजना', dEn: 'Picks the tools this run needs.', dHi: 'तय करता है कि कौन-से टूल चाहिए।' },
  { icon: 'search', en: 'Call tools', hi: 'टूल चलाना', dEn: 'OSV.dev, EPSS, CISA KEV and npm.', dHi: 'OSV.dev, EPSS, CISA KEV और npm।' },
  { icon: 'sparkle', en: 'Read your code', hi: 'कोड पढ़ना', dEn: 'Does your code call the vulnerable function?', dHi: 'क्या आपका कोड कमज़ोर फ़ंक्शन चलाता है?', ai: true },
  { icon: 'shield-check', en: 'Verify the fix', hi: 'सुधार पक्का करना', dEn: 'Every upgrade is re-checked.', dHi: 'हर अपग्रेड दोबारा जाँचा जाता है।' },
  { icon: 'list', en: 'Report the fix order', hi: '', dEn: 'Exact commands, in priority order.', dHi: '' },
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
              <span className="kv-t-tool">[report]</span> fix order + exact commands
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
