import { MOCK_RESULT } from '../../mock'
import { SeverityBadge, TierBadge, VerdictBadge } from '../ui/Badges'
import { SectionHead } from './SectionHead'

// Source: samples/demo-app/EXPECTED.md (QuickNotes sample). 251 packages matched to OSV.dev give 76 advisories
// across 21 vulnerable packages, identical to OSV-Scanner 2.7.0. Largest eight shown, in count order.
const FLAT_LIST: [string, number][] = [
  ['axios@0.21.0', 25],
  ['lodash@4.17.15', 6],
  ['nanoid@3.1.12', 5],
  ['js-yaml@3.14.0', 5],
  ['minimatch@3.0.4', 4],
  ['qs@6.7.0', 4],
  ['jsonwebtoken@8.5.1', 3],
  ['body-parser@1.19.0', 3],
]
const FLAT_REST = 21 - FLAT_LIST.length

const EXAMPLE =
  MOCK_RESULT.findings.find((f) => f.advisory.id === 'GHSA-35jh-r3h4-6jhm') ?? MOCK_RESULT.findings[0]!
const EXAMPLE_PLAN = MOCK_RESULT.plans.find((p) => p.name === EXAMPLE.pkg.name && p.from === EXAMPLE.pkg.version)

export function Problem() {
  return (
    <section id="problem" className="lp-section" aria-labelledby="problem-title">
      <div className="lp-wrap">
        <SectionHead
          id="problem-title"
          eyebrow="The problem"
          title="A longer list is not a plan."
        />

        <div className="lp-compare">
          <div className="lp-compare__col">
            <div className="lp-compare__head">
              <h3>Conventional scanner output</h3>
              <span className="subtle">QuickNotes sample</span>
            </div>
            <p className="lp-stat">
              <span className="lp-stat__n num">76</span>
              <span className="lp-stat__l">
                advisories in 251 packages, in no useful order
              </span>
            </p>
            <ul className="lp-flat" aria-label="Vulnerable packages and their advisory counts, flat list">
              {FLAT_LIST.map(([name, n]) => (
                <li key={name}>
                  <span className="mono">{name}</span>
                  <span className="mono num subtle">
                    {n} {n === 1 ? 'advisory' : 'advisories'}
                  </span>
                </li>
              ))}
              <li className="lp-flat__rest subtle">+ {FLAT_REST} more vulnerable packages</li>
            </ul>
          </div>

          <div className="lp-compare__col">
            <div className="lp-compare__head">
              <h3>Vulnera</h3>
              <span className="badge badge--accent">Demo data</span>
            </div>
            <p className="lp-stat">
              <span className="lp-stat__l">The same matches, as a decision.</span>
            </p>
            <div className="lp-example">
              <div className="lp-example__head">
                <TierBadge tier={EXAMPLE.tier} />
                <span className="lp-example__pkg">
                  {EXAMPLE.pkg.name}@{EXAMPLE.pkg.version}
                </span>
                <SeverityBadge severity={EXAMPLE.advisory.severity} />
                <VerdictBadge verdict={EXAMPLE.ai?.verdict ?? 'NOT_ASSESSED'} />
              </div>
              <h4 className="lp-example__label">Why this tier</h4>
              <ul className="lp-reasons">
                {EXAMPLE.reasons.map((r) => (
                  <li key={r}>{r}</li>
                ))}
              </ul>
              {EXAMPLE_PLAN?.command && EXAMPLE_PLAN.to && (
                <>
                  <h4 className="lp-example__label">
                    Fix: {EXAMPLE_PLAN.from} to {EXAMPLE_PLAN.to}
                  </h4>
                  <div className="cmd">
                    <span className="cmd__prompt" aria-hidden="true">
                      $
                    </span>
                    <pre>
                      <code>{EXAMPLE_PLAN.command}</code>
                    </pre>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}
