import type { ReactNode } from 'react'
import type { Tier } from '../../types'
import { AiTag, TierBadge, VerifiedTag } from '../ui/Badges'
import { SectionHead } from './SectionHead'

interface Step {
  title: string
  body: string
  tags: ReactNode
}

const STEPS: Step[] = [
  {
    title: 'Scan dependencies',
    body: 'Reads every exact version, then matches each against OSV.dev.',
    tags: (
      <>
        <span className="badge badge--mono">OSV.dev</span>
        <VerifiedTag>Exact lookup</VerifiedTag>
      </>
    ),
  },
  {
    title: 'Assess risk',
    body: 'EPSS, CISA KEV, severity and scope, through fixed tier rules.',
    tags: (
      <>
        <span className="badge badge--mono">EPSS</span>
        <span className="badge badge--mono">CISA KEV</span>
        <VerifiedTag>Fixed rules</VerifiedTag>
      </>
    ),
  },
  {
    title: 'Analyse relevant code',
    body: 'Gemini reads only the code that imports the package; each cited line is re-checked.',
    tags: (
      <>
        <AiTag>Gemini</AiTag>
        <VerifiedTag>Citations checked</VerifiedTag>
      </>
    ),
  },
  {
    title: 'Generate a verified fix plan',
    body: 'The smallest clean version, re-checked, with the exact npm command.',
    tags: (
      <>
        <span className="badge badge--mono">npm</span>
        <VerifiedTag>Re-checked on OSV</VerifiedTag>
      </>
    ),
  },
]

const RULES: { tier: Tier; rule: string }[] = [
  { tier: 'FIX_NOW', rule: 'On CISA KEV; or High or Critical in production with EPSS of 10% or more, or with your code calling the vulnerable function.' },
  { tier: 'FIX_SPRINT', rule: 'Other High or Critical in production; or Moderate in production with EPSS of 10% or more.' },
  { tier: 'PLAN', rule: 'Other production findings.' },
  { tier: 'MONITOR', rule: 'Development-only packages. Kept visible, because build tools can be attacked too.' },
]

export function HowItWorks() {
  return (
    <section id="how-it-works" className="lp-section" aria-labelledby="how-title">
      <div className="lp-wrap">
        <SectionHead
          id="how-title"
          eyebrow="How it works"
          title="From lockfile to fix plan in four steps."
          lede="Each step is marked: lookup, rule or AI judgement."
        />

        <ol className="lp-steps">
          {STEPS.map((s, i) => (
            <li key={s.title} className="lp-step">
              <div className="lp-step__rail">
                <span className="lp-step__n">0{i + 1}</span>
              </div>
              <div className="lp-step__body">
                <h3>{s.title}</h3>
                <p>{s.body}</p>
                <div className="lp-step__tags">{s.tags}</div>
              </div>
            </li>
          ))}
        </ol>

        <div className="lp-rules">
          <div className="lp-rules__intro">
            <h3>The tier rules, in full</h3>
            <p className="muted">
              Fixed and published. AI can raise a finding by confirming that your code calls the vulnerable function. It cannot lower one. Your own architecture can: code that only runs behind login, on a private network or in a nightly job moves down one step, with the file and line that prove it.
            </p>
          </div>
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
