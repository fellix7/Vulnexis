import type { Tier } from '../../types'
import { TierBadge } from '../ui/Badges'
import { SectionHead } from './SectionHead'

const RULES: { tier: Tier; rule: string }[] = [
  { tier: 'FIX_NOW', rule: 'On CISA KEV, or High/Critical in production with EPSS ≥ 10% or confirmed code use.' },
  { tier: 'FIX_SPRINT', rule: 'Other High/Critical in production, or Moderate with EPSS ≥ 10%.' },
  { tier: 'PLAN', rule: 'Other production findings.' },
  { tier: 'MONITOR', rule: 'Development-only packages, kept visible.' },
]

export function HowItWorks() {
  return (
    <section id="how-it-works" className="lp-section" aria-labelledby="how-title">
      <div className="lp-wrap">
        <SectionHead
          id="how-title"
          title="Four tiers. Fixed, published rules."
        />


        <div className="lp-rules">
          <p className="lp-rules__intro muted">
            AI can raise a tier, never lower it. Your architecture can lower one step: code behind login, on a private network or never loaded.
          </p>
          <div className="panel lp-rules__panel">
            <div className="table-wrap">
              <table className="dtable">
                <caption className="sr-only">Rules that place a finding in each tier</caption>
                <thead>
                  <tr>
                    <th scope="col">Tier</th>
                    <th scope="col">Rule</th>
                  </tr>
                </thead>
                <tbody>
                  {RULES.map((r) => (
                    <tr key={r.tier}>
                      <th scope="row" className="lp-rules__tier">
                        <TierBadge tier={r.tier} />
                      </th>
                      <td>{r.rule}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}
