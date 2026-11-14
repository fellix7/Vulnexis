import { MOCK_RESULT } from '../../mock'
import { AiTag, VerdictBadge, VerifiedTag } from '../ui/Badges'
import { Icon } from '../ui/Icon'
import { SectionHead } from './SectionHead'

const CELLS = [
  {
    title: 'Exact dependency inventory',
    body: 'Every installed version and the chain that pulled it in, matched exactly against OSV.dev.',
    tag: <VerifiedTag>Lookup, not AI</VerifiedTag>,
  },
  {
    title: 'Transparent risk prioritisation',
    body: 'Four tiers from fixed, published rules; every finding says why it landed there.',
    tag: <VerifiedTag>Published rules</VerifiedTag>,
  },
  {
    title: 'Verified upgrade recommendations',
    body: 'The smallest safe version, re-checked so the upgrade is not vulnerable too.',
    tag: <VerifiedTag>Re-checked on OSV</VerifiedTag>,
  },
  {
    title: 'Evidence-backed AI explanations',
    body: 'AI reasoning is always marked, and every quoted line is checked against your file.',
    tag: <AiTag>AI, with checked citations</AiTag>,
  },
]

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
            <h3 id="why-feature-title">Does your code actually call the vulnerable function?</h3>
            <p className="muted">
              Gemini names the line it relied on; Vulnexis re-checks that line in your file. Unreviewed findings say <strong>Not assessed</strong>,
              never “safe”.
            </p>
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
              <p className="lp-evidence__legend subtle">
                Dashed violet is AI-written interpretation. Solid green is data that was looked up or checked.
              </p>
            </div>
          )}
        </article>

        <div className="lp-cells">
          {CELLS.map((c, i) => (
            <article key={c.title} className="lp-cell">
              <span className="lp-cell__n">0{i + 1}</span>
              <h3>{c.title}</h3>
              <p className="muted">{c.body}</p>
              <div className="lp-cell__tag">{c.tag}</div>
            </article>
          ))}
        </div>
      </div>
    </section>
  )
}
