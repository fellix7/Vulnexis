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
      title={tr('How the agent reached this answer', 'एजेंट इस नतीजे तक कैसे पहुँचा')}
      description={tr(
        'Every tool the agent called, what went in, what came back and what it decided next, with links to each data source. Nothing is hidden, nothing is invented.',
        'एजेंट ने कौन-सा टूल चलाया, उसमें क्या गया, क्या मिला, और आगे क्या फ़ैसला लिया: हर डेटा स्रोत के लिंक के साथ। कुछ छिपा नहीं, कुछ गढ़ा नहीं।',
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
              <h3>{tr('Rules the agent cannot break', 'एजेंट के पक्के नियम')}</h3>
              <ul>
                <li>{tr('Facts come from OSV.dev. AI never adds or removes a vulnerability.', 'तथ्य OSV.dev से आते हैं। AI कोई कमज़ोरी न जोड़ता है, न हटाता है।')}</li>
                <li>{tr('AI may raise a priority, never lower it.', 'AI प्राथमिकता बढ़ा सकता है, घटा नहीं सकता।')}</li>
                <li>{tr('Only quoted architecture facts (login wall, private network, offline, not loaded) or a person can lower one: one step, never below Plan, never for KEV.', 'सिर्फ़ उद्धृत आर्किटेक्चर तथ्य (लॉगिन, निजी नेटवर्क, ऑफ़लाइन, लोड नहीं) या इंसान प्राथमिकता घटा सकते हैं: एक कदम, Plan से नीचे नहीं, KEV पर कभी नहीं।')}</li>
                <li>{tr('Every code citation is re-checked against the real file.', 'हर कोड-उद्धरण असली फ़ाइल से दोबारा मिलाया जाता है।')}</li>
                <li>{tr('When it does not know, it says "uncertain" instead of guessing.', 'जब पता न हो, तो अंदाज़ा नहीं, "पक्का नहीं" कहता है।')}</li>
                <li>{tr('No personal data is asked for. Code is read, never run.', 'कोई निजी जानकारी नहीं माँगी जाती। कोड सिर्फ़ पढ़ा जाता है, चलाया नहीं।')}</li>
              </ul>
            </section>
          </aside>
        </div>
      )}
    </div>
  )
}
