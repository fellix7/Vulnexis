import { MOCK_RESULT } from '../../mock'
import { useLang } from '../../lib/i18n'
import { AgentTimeline } from '../agent/AgentTimeline'
import { Link } from '../../router'
import { Icon } from '../ui/Icon'
import { ProductPreview } from './ProductPreview'
import { useOpenDemo } from './useOpenDemo'

// Four decision steps from the labelled demo run: the agent's signature move, on the first screen.
const HERO_STEPS = (MOCK_RESULT.agent ?? []).filter((s) => ['s1', 's3', 's4', 's6', 's8'].includes(s.id))

export function Hero() {
  const openDemo = useOpenDemo()
  const { tr } = useLang()
  return (
    <>
      <section className="lp-hero" aria-labelledby="hero-title">
        <div className="lp-wrap lp-hero__grid">
          <div className="lp-hero__copy">
            <h1 id="hero-title">
              <span>{tr('Fix what matters.', 'जो ज़रूरी है, वो ठीक करें।')}</span>{' '}
              <span>{tr('Ignore the noise.', 'बाक़ी शोर छोड़ें।')}</span>
            </h1>
            <p className="lp-hero__lede">
              {tr(
                'A security agent for small teams: paste a GitHub link, get a verified fix order in minutes.',
                'भारतीय टीमों के लिए सुरक्षा एजेंट: GitHub लिंक डालें, हिंदी या अंग्रेज़ी में पक्का सुधार-क्रम पाएँ।',
              )}
            </p>
            <div className="lp-hero__cta">
              <Link to="/scan" className="btn btn--primary btn--lg">
                <Icon name="github" size={16} />
                {tr('Scan a GitHub repo', 'GitHub रिपॉज़िटरी स्कैन करें')}
              </Link>
              <button type="button" className="btn btn--lg" onClick={openDemo}>
                <Icon name="beaker" size={16} />
                {tr('Explore the demo', 'डेमो देखें')}
              </button>
            </div>
          </div>
          <figure className="lp-hero__agent">
            <figcaption>
              <span>{tr('The agent, showing its work', 'एजेंट, अपना काम दिखाते हुए')}</span>
              <span className="badge badge--accent">{tr('Demo data', 'डेमो डेटा')}</span>
            </figcaption>
            <AgentTimeline steps={HERO_STEPS} compact />
          </figure>
        </div>
      </section>
      <section className="lp-showcase" aria-label={tr('Example result (demo data)', 'उदाहरण नतीजा (डेमो डेटा)')}>
        <div className="lp-wrap">
          <ProductPreview />
        </div>
      </section>
    </>
  )
}
