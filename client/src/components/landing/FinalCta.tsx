import { useLang } from '../../lib/i18n'
import { Link } from '../../router'
import { Icon } from '../ui/Icon'
import { useOpenDemo } from './useOpenDemo'

export function FinalCta() {
  const openDemo = useOpenDemo()
  const { tr } = useLang()
  return (
    <section className="lp-section lp-section--cta" aria-labelledby="cta-title">
      <div className="lp-wrap">
        <div className="lp-cta">
          <div className="lp-cta__text">
            <h2 id="cta-title" className="lp-title">
              {tr('Paste your repo link. Get the fix order in a minute.', 'अपनी रिपॉज़िटरी का लिंक डालें। एक मिनट में सुधार का क्रम पाएँ।')}
            </h2>
            <p className="lp-lede">{tr('Works from a phone. Or open the clearly labelled demo to look around first.', 'फ़ोन से भी चलता है। या पहले साफ़ तौर पर चिह्नित डेमो देखें।')}</p>
          </div>
          <div className="lp-cta__actions">
            <Link to="/scan" className="btn btn--primary btn--lg">
              {tr('Scan a project', 'प्रोजेक्ट स्कैन करें')}
              <Icon name="arrow-right" size={16} />
            </Link>
            <button type="button" className="btn btn--lg" onClick={openDemo}>
              <Icon name="beaker" size={16} />
              {tr('Explore the demo', 'डेमो देखें')}
            </button>
          </div>
        </div>
      </div>
    </section>
  )
}
