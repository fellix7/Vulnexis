import { MOCK_RESULT } from '../../mock'
import { AiTag, VerdictBadge, VerifiedTag } from '../ui/Badges'
import { Icon } from '../ui/Icon'
import { SectionHead } from './SectionHead'

const EXAMPLE = MOCK_RESULT.findings.find((f) => f.advisory.id === 'GHSA-phwq-j96m-2c2q' && f.ai?.citations[0])
const CITATION = EXAMPLE?.ai?.citations[0]

export function Why() {
  return (
    <section id="why" className="lp-section" aria-labelledby="why-title">
      <div className="lp-wrap">
        <SectionHead
          id="why-title"
          title="Every claim comes with its evidence."
        />

        <article className="lp-feature" aria-labelledby="why-feature-title">
          <div className="lp-feature__text">
            <h3 id="why-feature-title">Does your code call the vulnerable function?</h3>
            <p className="muted">Every cited line is re-checked in your file.</p>
            <ul className="lp-verdicts" aria-label="The three possible verdicts">
              <li>
                <VerdictBadge verdict="USES_VULNERABLE_API" />
              </li>
              <li>
                <VerdictBadge verdict="NO_VULNERABLE_USAGE_FOUND" />
              </li>
              <li>
                <VerdictBadge verdict="UNCERTAIN" />
              </li>
            </ul>
          </div>

          {EXAMPLE?.ai && CITATION && (
            <div className="lp-evidence">
              <div className="lp-evidence__head">
                <span className="mono">
                  {EXAMPLE.pkg.name}@{EXAMPLE.pkg.version}
                </span>
                <span className="badge badge--accent">
                  <Icon name="beaker" size={12} />
                  Demo data
                </span>
              </div>
              <div className="lp-evidence__ai">
                <div className="cluster">
                  <AiTag />
                  <VerdictBadge verdict={EXAMPLE.ai.verdict} />
                </div>
                <p>{EXAMPLE.ai.reasoning}</p>
              </div>
              <div className="lp-evidence__cite">
                <div className="cluster">
                  <VerifiedTag>Citation checked against the file</VerifiedTag>
                  <span className="mono lp-evidence__loc">
                    {CITATION.file}:{CITATION.line}
                  </span>
                </div>
                <pre className="code">
                  <span className="lp-evidence__ln" aria-hidden="true">
                    {CITATION.line}
                  </span>
                  <code>{CITATION.quote}</code>
                </pre>
              </div>
            </div>
          )}
        </article>

      </div>
    </section>
  )
}
