import { useMemo, useState } from 'react'
import { TierBadge } from '../components/ui/Badges'
import { Icon } from '../components/ui/Icon'
import { CopyButton, NoScan, PageHeader } from '../components/ui/Kit'
import { buildIndiaBrief, categorize, CATEGORIES, whatsappText, type RiskLevel } from '../lib/india'
import { useLang } from '../lib/i18n'
import { effectiveTier, findingKey } from '../lib/review'
import { byPriority, findingHref } from '../lib/selectors'
import { Link } from '../router'
import { useScan } from '../state/store'
import './india.css'

const LEVEL: Record<RiskLevel, { en: string; hi: string; icon: 'flame' | 'alert' | 'clock' | 'shield-check' }> = {
  critical: { en: 'Act today', hi: 'आज ही कदम उठाएँ', icon: 'flame' },
  high: { en: 'Fix this week', hi: 'इस हफ़्ते ठीक करें', icon: 'alert' },
  medium: { en: 'Plan the fixes', hi: 'सुधार की योजना बनाएँ', icon: 'clock' },
  low: { en: 'In good shape', hi: 'स्थिति ठीक है', icon: 'shield-check' },
}

const APPLIES = {
  now: { en: 'Applies now', hi: 'अभी लागू', cls: 'ib-applies--now' },
  'if-exploited': { en: 'If exploited', hi: 'हमला होने पर', cls: 'ib-applies--if' },
  ongoing: { en: 'Always', hi: 'हमेशा', cls: 'ib-applies--ongoing' },
}

const MAX_PLAIN = 8

export default function IndiaPage() {
  const { current } = useScan()
  const { tr, lang } = useLang()
  const [showBoth, setShowBoth] = useState(false)

  const brief = useMemo(() => (current ? buildIndiaBrief(current.result, current.review) : null), [current])
  const header = (
    <PageHeader
      eyebrow={tr('India brief', 'भारत रिपोर्ट')}
      title={tr('What this means for your business', 'आपके बिज़नेस के लिए इसका मतलब')}
      description={tr(
        'The scan in plain Hindi and English, mapped to CERT-In and the DPDP Act, with a summary you can send to your founder or client on WhatsApp.',
        'स्कैन का नतीजा आसान हिंदी और अंग्रेज़ी में, CERT-In और DPDP अधिनियम के हिसाब से, और WhatsApp पर भेजने लायक सारांश।',
      )}
    />
  )
  if (!current || !brief) {
    return (
      <div className="ib-page">
        {header}
        <NoScan what="the India brief" />
      </div>
    )
  }

  const level = LEVEL[brief.level]
  const msg = whatsappText(brief, current.projectName, lang)
  const plain = current.result.findings
    .filter((f) => !f.pkg.dev)
    .slice()
    .sort(byPriority(current.review))
    .slice(0, MAX_PLAIN)

  return (
    <div className="ib-page">
      {header}

      <section className={`ib-hero ib-hero--${brief.level}`} aria-labelledby="ib-verdict">
        <div className="ib-hero__verdict">
          <span className="ib-hero__icon" aria-hidden="true">
            <Icon name={level.icon} size={20} />
          </span>
          <div>
            <span className="eyebrow">{tr('Verdict', 'नतीजा')}</span>
            <h2 id="ib-verdict">{tr(level.en, level.hi)}</h2>
          </div>
        </div>
        <p className="ib-hero__summary" lang={lang}>
          {lang === 'hi' ? brief.summaryHi : brief.summaryEn}
        </p>
        {showBoth && (
          <p className="ib-hero__summary ib-hero__summary--alt" lang={lang === 'hi' ? 'en' : 'hi'}>
            {lang === 'hi' ? brief.summaryEn : brief.summaryHi}
          </p>
        )}
        <div className="ib-hero__stats">
          <div>
            <span className="num">{brief.fixNow}</span>
            {tr('fix today', 'आज ठीक करें')}
          </div>
          <div>
            <span className="num">{brief.kev}</span>
            {tr('used in real attacks', 'असली हमलों में')}
          </div>
          <div>
            <span className="num">{brief.personalData.length}</span>
            {tr('could expose personal data', 'निजी डेटा का ख़तरा')}
          </div>
        </div>
        <div className="cluster ib-hero__actions">
          <a className="btn btn--primary" href={`https://wa.me/?text=${encodeURIComponent(msg)}`} target="_blank" rel="noreferrer noopener">
            <Icon name="message" size={14} />
            {tr('Share on WhatsApp', 'WhatsApp पर भेजें')}
          </a>
          <CopyButton text={msg} label={tr('Copy summary', 'सारांश कॉपी करें')} className="btn" />
          <button type="button" className="btn btn--ghost" onClick={() => setShowBoth((v) => !v)} aria-pressed={showBoth}>
            <Icon name="globe" size={14} />
            {showBoth ? tr('Hide Hindi', 'अंग्रेज़ी छिपाएँ') : tr('Show in Hindi too', 'अंग्रेज़ी में भी दिखाएँ')}
          </button>
        </div>
      </section>

      <div className="ib-grid">
        <section className="panel">
          <div className="panel__head">
            <h2>{tr('Do this next', 'अब यह करें')}</h2>
          </div>
          <ol className="ib-steps">
            {brief.steps.map((s, i) => (
              <li key={i}>
                <span className="ib-steps__n num">{i + 1}</span>
                <span>{lang === 'hi' ? s.hi : s.en}</span>
              </li>
            ))}
          </ol>
          <div className="ib-steps__links">
            <Link to="/remediation" className="btn btn--sm">
              <Icon name="wrench" size={13} />
              {tr('Upgrade commands', 'अपग्रेड कमांड')}
            </Link>
            <Link to="/agent" className="btn btn--ghost btn--sm">
              <Icon name="bot" size={13} />
              {tr('How the agent decided', 'एजेंट ने कैसे तय किया')}
            </Link>
          </div>
        </section>

        <section className="panel">
          <div className="panel__head">
            <h2>{tr('What kind of risk', 'किस तरह का ख़तरा')}</h2>
            <span className="subtle">{tr('production only', 'सिर्फ़ प्रोडक्शन')}</span>
          </div>
          <ul className="ib-cats">
            {brief.byCategory.length === 0 && <li className="subtle">{tr('No production findings.', 'प्रोडक्शन में कोई कमज़ोरी नहीं।')}</li>}
            {brief.byCategory.map(({ category, count }) => {
              const c = CATEGORIES[category]
              const max = brief.byCategory[0]!.count
              return (
                <li key={category}>
                  <div className="ib-cats__row">
                    <span>
                      {tr(c.en, c.hi)}
                      {c.personalData && (
                        <span className="ib-pd" title={tr('Could expose personal data', 'निजी डेटा का ख़तरा')}>
                          {tr('personal data', 'निजी डेटा')}
                        </span>
                      )}
                    </span>
                    <span className="num">{count}</span>
                  </div>
                  <span className="ib-cats__bar" style={{ width: `${(count / max) * 100}%` }} />
                </li>
              )
            })}
          </ul>
        </section>
      </div>

      <section className="ib-section" aria-labelledby="ib-law">
        <div className="ib-section__head">
          <h2 id="ib-law">
            <Icon name="scale" size={16} />
            {tr('Indian rules that apply', 'लागू होने वाले भारतीय नियम')}
          </h2>
          <p className="subtle">{tr('For information, not legal advice. Check the linked source.', 'सिर्फ़ जानकारी के लिए, क़ानूनी सलाह नहीं। दिए गए स्रोत को देखें।')}</p>
        </div>
        <div className="ib-laws">
          {brief.obligations.map((o) => {
            const a = APPLIES[o.applies]
            return (
              <article key={o.id} className="ib-law">
                <div className="ib-law__head">
                  <h3>{tr(o.lawEn, o.lawHi)}</h3>
                  <span className={`ib-applies ${a.cls}`}>{tr(a.en, a.hi)}</span>
                </div>
                <p className="ib-law__rule">{tr(o.ruleEn, o.ruleHi)}</p>
                <p className="ib-law__why">
                  <strong>{tr('For this scan: ', 'इस स्कैन के लिए: ')}</strong>
                  {tr(o.whyEn, o.whyHi)}
                </p>
                <a className="ib-law__src" href={o.source.url} target="_blank" rel="noreferrer noopener">
                  <Icon name="external" size={11} />
                  {o.source.label}
                </a>
              </article>
            )
          })}
        </div>
      </section>

      <section className="ib-section" aria-labelledby="ib-plain">
        <div className="ib-section__head">
          <h2 id="ib-plain">
            <Icon name="message" size={16} />
            {tr('In plain words', 'आसान शब्दों में')}
          </h2>
          <p className="subtle">
            {tr(
              `The ${plain.length} most urgent production findings, explained without jargon.`,
              `प्रोडक्शन की ${plain.length} सबसे ज़रूरी कमज़ोरियाँ, बिना तकनीकी शब्दों के।`,
            )}
          </p>
        </div>
        <ul className="ib-plain">
          {plain.map((f) => {
            const c = CATEGORIES[categorize(f)]
            return (
              <li key={findingKey(f)}>
                <Link to={findingHref(f)} className="ib-plain__item">
                  <div className="ib-plain__top">
                    <TierBadge tier={effectiveTier(f, current.review[findingKey(f)])} />
                    <code>
                      {f.pkg.name}@{f.pkg.version}
                    </code>
                    <span className="ib-plain__cat">{tr(c.en, c.hi)}</span>
                  </div>
                  <p>{tr(c.plainEn, c.plainHi)}</p>
                  <span className="ib-plain__src subtle">
                    {tr('Source', 'स्रोत')}: {f.advisory.id}
                    {f.advisory.aliases[0] ? ` · ${f.advisory.aliases[0]}` : ''}
                    <Icon name="chevron-right" size={12} />
                  </span>
                </Link>
              </li>
            )
          })}
        </ul>
      </section>
    </div>
  )
}
