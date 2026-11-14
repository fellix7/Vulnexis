import { AgentTimeline, TOOL_META } from '../components/agent/AgentTimeline'
import { Icon } from '../components/ui/Icon'
import { Callout, NoScan, PageHeader } from '../components/ui/Kit'
import { useLang } from '../lib/i18n'
import { Link } from '../router'
import { useScan } from '../state/store'
import type { AgentTool } from '../types'
import './agent-page.css'

export default function AgentPage() {
  const { current } = useScan()
  const { tr } = useLang()

  const header = (
    <PageHeader
      eyebrow={tr('Agent trace', 'एजेंट का काम')}
      title={tr('Agent trace', 'एजेंट का काम')}
      description={tr(
        'Every tool it called, what it found and what it decided.',
        'हर टूल, क्या मिला और क्या फ़ैसला हुआ।',
      )}
    />
  )

  if (!current) {
    return (
      <div className="agent-page">
        {header}
        <NoScan what="the agent trace" />
      </div>
    )
  }

  const steps = current.result.agent ?? []
  const total = steps.reduce((m, s) => Math.max(m, s.startedAt + (s.ms ?? 0)), 0)
  const used = [...new Set(steps.filter((s) => s.status === 'done').map((s) => s.tool))] as AgentTool[]
  const decisions = steps.filter((s) => s.decision).length
  const sources = new Map(steps.flatMap((s) => s.sources ?? []).map((s) => [s.url, s]))

  return (
    <div className="agent-page">
      {header}
      {steps.length === 0 ? (
        <Callout tone="info">
          {tr(
            'This scan was saved before the agent trace existed, so there are no steps to show. Run a new scan to see the agent at work.',
            'यह स्कैन एजेंट ट्रेस से पहले सेव हुआ था। एजेंट को काम करते देखने के लिए नया स्कैन चलाएँ।',
          )}{' '}
          <Link to="/scan" className="link">
            {tr('New scan', 'नया स्कैन')}
          </Link>
        </Callout>
      ) : (
        <div className="agent-grid">
          <section className="panel">
            <div className="panel__head">
              <h2>{tr('Run, step by step', 'हर कदम')}</h2>
              <span className="subtle num">{(total / 1000).toFixed(1)} s</span>
            </div>
            <div className="panel__body">
              <AgentTimeline steps={steps} />
            </div>
          </section>

          <aside className="agent-side">
            <div className="agent-stats">
              <div>
                <span className="agent-stat__n num">{steps.length}</span>
                <span className="agent-stat__l">{tr('steps', 'कदम')}</span>
              </div>
              <div>
                <span className="agent-stat__n num">{used.length}</span>
                <span className="agent-stat__l">{tr('tools used', 'टूल')}</span>
              </div>
              <div>
                <span className="agent-stat__n num">{decisions}</span>
                <span className="agent-stat__l">{tr('decisions', 'फ़ैसले')}</span>
              </div>
            </div>

            <section className="agent-box">
              <h3>{tr('Tools this run used', 'इस रन के टूल')}</h3>
              <ul className="agent-toollist">
                {used.map((t) => (
                  <li key={t}>
                    <span className={`agent-tool agent-tool--${t}`}>
                      <Icon name={TOOL_META[t].icon} size={12} />
                      {tr(TOOL_META[t].en, TOOL_META[t].hi)}
                    </span>
                  </li>
                ))}
              </ul>
            </section>

            <section className="agent-box">
              <h3>{tr('Sources cited', 'स्रोत')}</h3>
              <ul className="agent-srclist">
                {[...sources.values()].map((s) => (
                  <li key={s.url}>
                    <a href={s.url} target="_blank" rel="noreferrer noopener">
                      {s.label}
                      <Icon name="external" size={11} />
                    </a>
                  </li>
                ))}
              </ul>
            </section>

            <section className="agent-box agent-box--rules">
              <h3>{tr('Rules it cannot break', 'पक्के नियम')}</h3>
              <ul>
                <li>{tr('Facts only from OSV.dev.', 'तथ्य सिर्फ़ OSV.dev से।')}</li>
                <li>{tr('AI can raise a priority, never lower it.', 'AI प्राथमिकता बढ़ा सकता है, घटा नहीं सकता।')}</li>
                <li>{tr('Architecture can lower one step, with a quoted line.', 'आर्किटेक्चर एक कदम घटा सकता है, सबूत के साथ।')}</li>
                <li>{tr('Every citation is re-checked.', 'हर उद्धरण दोबारा जाँचा जाता है।')}</li>
                <li>{tr('Unsure means "uncertain", never a guess.', 'पक्का नहीं तो "अनिश्चित", अंदाज़ा नहीं।')}</li>
                <li>{tr('Code is read, never run.', 'कोड पढ़ा जाता है, चलाया नहीं।')}</li>
              </ul>
            </section>
          </aside>
        </div>
      )}
    </div>
  )
}
