import { EvidenceList, ExposureBadge } from '../components/context/Exposure'
import { TierBadge } from '../components/ui/Badges'
import { Icon } from '../components/ui/Icon'
import { Callout, CommandBlock, EmptyState, NoScan, PageHeader } from '../components/ui/Kit'
import { EXPOSURE_ORDER, EXPOSURE_TEXT } from '../lib/exposure'
import { useLang } from '../lib/i18n'
import { findingHref } from '../lib/selectors'
import { TIER_ORDER } from '../lib/tiers'
import { Link } from '../router'
import { useScan } from '../state/store'
import type { ContextFileKind, Finding } from '../types'
import './architecture.css'

const KIND_LABEL: Record<ContextFileKind, string> = {
  vulnexis: 'vulnexis.yml (your declaration)',
  compose: 'Docker Compose',
  kubernetes: 'Kubernetes',
  serverless: 'Serverless',
  procfile: 'Procfile',
  dockerfile: 'Dockerfile',
  openapi: 'OpenAPI',
  manifest: 'package.json',
  markdown: 'Docs (Markdown)',
}

const EXAMPLE = `# vulnexis.yml (optional): tell Vulnexis what config cannot
components:
  web:
    entry: src/server.js
    exposure: public      # public | internal | login | offline
  reports:
    entry: src/jobs/reports.js
    exposure: offline`

export default function ArchitecturePage() {
  const { current } = useScan()
  const { tr } = useLang()
  const header = (
    <PageHeader
      title={tr('Architecture', 'आर्किटेक्चर')}
      description={tr(
        'Where each part of your project runs, who can reach it, and how that changed priorities. Read from your own deployment files, docs and code: every line is quoted.',
        'आपके प्रोजेक्ट का हर हिस्सा कहाँ चलता है, उस तक कौन पहुँच सकता है, और इससे प्राथमिकता कैसे बदली। आपकी अपनी डिप्लॉयमेंट फ़ाइलों, डॉक्स और कोड से: हर पंक्ति का हवाला।',
      )}
    />
  )
  if (!current) {
    return (
      <div className="arch-page">
        {header}
        <NoScan what="the architecture map" />
      </div>
    )
  }

  const { context, findings } = current.result
  if (!context || context.entryPoints.length === 0) {
    return (
      <div className="arch-page">
        {header}
        <div className="panel">
          <EmptyState icon="layers" title={tr('No architecture context in this scan', 'इस स्कैन में आर्किटेक्चर जानकारी नहीं')}>
            {tr(
              'Scan a GitHub repository, or upload the project folder next to the lockfile. Vulnexis reads docker-compose.yml, Kubernetes manifests, serverless.yml, Procfile, Dockerfile, OpenAPI specs, package.json, ARCHITECTURE.md / SECURITY.md and an optional vulnexis.yml to learn which code is internet-facing.',
              'GitHub रिपॉज़िटरी स्कैन करें, या लॉकफ़ाइल के साथ प्रोजेक्ट फ़ोल्डर अपलोड करें। Vulnexis docker-compose.yml, Kubernetes, serverless.yml, Procfile, Dockerfile, OpenAPI, package.json, ARCHITECTURE.md और vulnexis.yml पढ़कर समझता है कि कौन-सा कोड इंटरनेट से जुड़ा है।',
            )}
          </EmptyState>
        </div>
        <section className="panel arch-example">
          <div className="panel__head">
            <h2>{tr('Optional: declare it yourself', 'चाहें तो खुद बताएँ')}</h2>
          </div>
          <div className="panel__body">
            <CommandBlock command={EXAMPLE} prompt={false} />
          </div>
        </section>
      </div>
    )
  }

  const prod = findings.filter((f) => !f.pkg.dev && f.exposure)
  const byLevel = EXPOSURE_ORDER.map((l) => [l, prod.filter((f) => f.exposure!.level === l).length] as const).filter(([, n]) => n > 0)
  const lowered = findings.filter((f) => f.exposure?.lowered)
  const kept = findings.filter((f) => f.exposure?.level === 'login' && f.exposure.openSignup)

  return (
    <div className="arch-page">
      {header}

      <div className="arch-strip" role="list" aria-label={tr('Production findings by exposure', 'पहुँच के हिसाब से कमज़ोरियाँ')}>
        {byLevel.map(([level, n]) => (
          <Link key={level} to={`/findings?exposure=${level}`} className="arch-stat" role="listitem">
            <span className="arch-stat__n num">{n}</span>
            <ExposureBadge level={level} />
          </Link>
        ))}
        <div className="arch-stat arch-stat--moved" role="listitem">
          <span className="arch-stat__n num">{lowered.length}</span>
          <span className="arch-stat__l">
            <Icon name="arrow-down" size={12} />
            {tr('moved down one step', 'एक कदम नीचे')}
          </span>
        </div>
      </div>

      {context.conflicts.length > 0 && (
        <Callout tone="warn" role="note">
          <strong>{tr('Docs and code disagree', 'डॉक्स और कोड में फ़र्क़')}</strong>
          <ul className="arch-conflicts">
            {context.conflicts.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
        </Callout>
      )}

      <div className="arch-grid">
        <div className="arch-main">
          <section className="panel" aria-labelledby="arch-entries">
            <div className="panel__head">
              <h2 id="arch-entries">{tr('Entry points', 'एंट्री पॉइंट')}</h2>
              <span className="subtle">{tr('processes that run, and who can reach them', 'चलने वाले प्रोसेस और उन तक पहुँच')}</span>
            </div>
            <ul className="arch-entries">
              {context.entryPoints.map((e) => (
                <li key={e.component} className="arch-entry">
                  <div className="arch-entry__head">
                    <span className="arch-entry__name">{e.component}</span>
                    <ExposureBadge level={e.exposure} />
                  </div>
                  <p className="arch-entry__how">
                    {e.file ? (
                      <>
                        {tr('Starts', 'शुरू होता है')} <code>{e.file}</code> ·{' '}
                      </>
                    ) : (
                      <>{tr('Start file not in the scanned code', 'शुरुआती फ़ाइल स्कैन किए कोड में नहीं')} · </>
                    )}
                    {e.how}
                  </p>
                  <EvidenceList evidence={e.evidence.slice(0, 4)} />
                </li>
              ))}
            </ul>
          </section>

          {context.protectedMounts.length > 0 && (
            <section className="panel" aria-labelledby="arch-mounts">
              <div className="panel__head">
                <h2 id="arch-mounts">{tr('Routes behind login', 'लॉगिन के पीछे के रूट')}</h2>
              </div>
              <ul className="arch-mounts">
                {context.protectedMounts.map((m) => (
                  <li key={`${m.file}:${m.line}:${m.prefix}`}>
                    <code className="arch-mount__prefix">{m.prefix}</code>
                    <span>
                      {tr('guarded by', 'रक्षक')} <code>{m.guard}</code>
                    </span>
                    <span className="mono subtle">
                      {m.file}:{m.line}
                    </span>
                  </li>
                ))}
              </ul>
              {context.openSignup && (
                <div className="panel__body">
                  <Callout tone="warn">
                    {tr(
                      `Anyone can create an account (${context.openSignup.file}:${context.openSignup.line}), so a login wall does not lower any priority.`,
                      `कोई भी खाता बना सकता है (${context.openSignup.file}:${context.openSignup.line}), इसलिए लॉगिन से प्राथमिकता नहीं घटती।`,
                    )}
                  </Callout>
                </div>
              )}
            </section>
          )}

          <section className="panel" aria-labelledby="arch-moved">
            <div className="panel__head">
              <h2 id="arch-moved">{tr('Priority changes', 'प्राथमिकता में बदलाव')}</h2>
              <span className="subtle num">{lowered.length}</span>
            </div>
            {lowered.length === 0 ? (
              <div className="panel__body">
                <p className="subtle">
                  {tr(
                    'No finding moved: every vulnerable package is loaded by internet-facing code, is already Plan or Monitor, or is known exploited.',
                    'कोई बदलाव नहीं: हर कमज़ोर पैकेज इंटरनेट से जुड़े कोड में है, पहले से Plan/Monitor है, या असल हमलों में इस्तेमाल हो चुका है।',
                  )}
                </p>
              </div>
            ) : (
              <ul className="arch-moved">
                {lowered.map((f) => (
                  <MovedRow key={`${f.pkg.name}@${f.pkg.version}:${f.advisory.id}`} f={f} />
                ))}
              </ul>
            )}
            {kept.length > 0 && (
              <div className="panel__body">
                <p className="subtle">
                  {tr(
                    `${kept.length} behind-login findings kept their priority because sign-up is open.`,
                    `${kept.length} लॉगिन वाली कमज़ोरियों की प्राथमिकता नहीं घटी क्योंकि साइन-अप खुला है।`,
                  )}
                </p>
              </div>
            )}
          </section>
        </div>

        <aside className="arch-side">
          <section className="agent-box">
            <h3>{tr('Files read', 'पढ़ी गई फ़ाइलें')}</h3>
            <ul className="arch-files">
              {context.files.map((f) => (
                <li key={f.path}>
                  <code>{f.path}</code>
                  <span className="subtle">{KIND_LABEL[f.kind]}</span>
                </li>
              ))}
              <li>
                <span className="subtle">
                  {tr(`Import graph: ${context.reachedFiles} source files reached from the entry points`, `इम्पोर्ट ग्राफ़: ${context.reachedFiles} सोर्स फ़ाइलें एंट्री पॉइंट से जुड़ी`)}
                </span>
              </li>
            </ul>
          </section>

          <section className="agent-box agent-box--rules">
            <h3>{tr('How exposure changes a priority', 'पहुँच से प्राथमिकता कैसे बदलती है')}</h3>
            <ul>
              <li>{tr('Behind login, private network, offline, or not loaded at all: down one step.', 'लॉगिन के पीछे, निजी नेटवर्क, ऑफ़लाइन, या कहीं लोड नहीं: एक कदम नीचे।')}</li>
              <li>{tr('Never below Plan. Never for vulnerabilities exploited in the wild (CISA KEV).', 'Plan से नीचे कभी नहीं। असल हमलों वाली (CISA KEV) कमज़ोरी पर कभी नहीं।')}</li>
              <li>{tr('Unknown counts as internet-facing. When files disagree, the more exposed reading wins.', 'अज्ञात = इंटरनेट से जुड़ा। फ़ाइलों में मतभेद हो तो ज़्यादा जोखिम वाला मानते हैं।')}</li>
              <li>{tr('Docs never override config or code; a mismatch is reported above.', 'डॉक्स कभी कॉन्फ़िग या कोड से ऊपर नहीं; फ़र्क़ ऊपर दिखाया जाता है।')}</li>
              <li>{tr('"Not loaded" is only claimed when the whole import graph could be followed.', '"लोड नहीं" तभी कहा जाता है जब पूरा इम्पोर्ट ग्राफ़ पढ़ा जा सका।')}</li>
            </ul>
            <p className="arch-std">
              <a href="https://certcc.github.io/SSVC/reference/decision_points/system_exposure/" target="_blank" rel="noreferrer noopener">
                CISA SSVC: System Exposure <Icon name="external" size={11} />
              </a>
              <a href="https://www.cisa.gov/sites/default/files/2023-01/VEX_Status_Justification_Jun22.pdf" target="_blank" rel="noreferrer noopener">
                CISA VEX justifications <Icon name="external" size={11} />
              </a>
            </p>
            {!context.confident && (
              <p className="subtle arch-std">
                {tr(
                  'This project could not be followed completely (dynamic imports, file-based routing or skipped files), so nothing is marked "not loaded".',
                  'यह प्रोजेक्ट पूरी तरह नहीं पढ़ा जा सका, इसलिए किसी को "लोड नहीं" नहीं कहा गया।',
                )}
              </p>
            )}
          </section>
        </aside>
      </div>
    </div>
  )
}

function MovedRow({ f }: { f: Finding }) {
  const x = f.exposure!
  const from = TIER_ORDER[TIER_ORDER.indexOf(f.tier) - 1] ?? f.tier
  return (
    <li className="arch-move">
      <Link to={findingHref(f)} className="arch-move__link">
        <span className="arch-move__pkg">
          {f.pkg.name}
          <span className="subtle">@{f.pkg.version}</span>
        </span>
        <span className="arch-move__id mono subtle">{f.advisory.id}</span>
        <span className="arch-move__tiers">
          <TierBadge tier={from} />
          <Icon name="arrow-right" size={12} />
          <TierBadge tier={f.tier} />
        </span>
      </Link>
      <p className="arch-move__why">
        <ExposureBadge level={x.level} compact /> {x.reason}
      </p>
      <p className="sr-only">{EXPOSURE_TEXT[x.level].blurb}</p>
    </li>
  )
}
