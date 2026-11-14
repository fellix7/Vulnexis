import { useLang } from '../../lib/i18n'
import { Link } from '../../router'
import { Icon } from '../ui/Icon'
import { ProductPreview } from './ProductPreview'
import { useOpenDemo } from './useOpenDemo'

export function Hero() {
  const openDemo = useOpenDemo()
  const { tr } = useLang()
  return (
    <section className="lp-hero" aria-labelledby="hero-title">
      <div className="lp-wrap">
        <div className="lp-hero__copy">
          <p className="eyebrow lp-hero__eyebrow">
            <span className="lp-flag" aria-hidden="true" />
            {tr('AI security agent for India’s builders', 'भारत के डेवलपर्स के लिए AI सुरक्षा एजेंट')}
          </p>
          <h1 id="hero-title">
            <span>{tr('Fix what matters.', 'जो ज़रूरी है, वो ठीक करें।')}</span>{' '}
            <span className="lp-hero__dim">{tr('Ignore the noise.', 'बाक़ी शोर छोड़ें।')}</span>
          </h1>
          <p className="lp-hero__lede">
            {tr(
              'Paste a GitHub link. Kavach’s agent finds the vulnerable packages, checks whether your code really calls the vulnerable function, verifies the safest upgrade, and explains it in Hindi or English, mapped to CERT-In and the DPDP Act.',
              'GitHub लिंक डालें। Kavach का एजेंट कमज़ोर पैकेज ढूँढता है, जाँचता है कि आपका कोड सच में कमज़ोर फ़ंक्शन चलाता है या नहीं, सबसे सुरक्षित अपग्रेड पक्का करता है, और सब कुछ हिंदी या अंग्रेज़ी में, CERT-In और DPDP अधिनियम के हिसाब से समझाता है।',
            )}
          </p>
          <div className="lp-hero__cta">
            <Link to="/scan" className="btn btn--primary btn--lg">
              {tr('Scan a GitHub repo', 'GitHub रिपॉज़िटरी स्कैन करें')}
              <Icon name="arrow-right" size={16} />
            </Link>
            <button type="button" className="btn btn--lg" onClick={openDemo}>
              <Icon name="beaker" size={16} />
              {tr('Explore the demo', 'डेमो देखें')}
            </button>
          </div>
          <p className="lp-hero__trust">
            <span>
              <Icon name="lock" size={14} />
              {tr('Code is read, never installed or run', 'कोड सिर्फ़ पढ़ा जाता है, चलाया नहीं')}
            </span>
            <span className="lp-hero__sep" aria-hidden="true">
              ·
            </span>
            <span>
              <Icon name="shield-check" size={14} />
              {tr('No personal data asked. Ever.', 'कोई निजी जानकारी नहीं माँगी जाती')}
            </span>
          </p>
        </div>
        <ProductPreview />
      </div>
    </section>
  )
}
