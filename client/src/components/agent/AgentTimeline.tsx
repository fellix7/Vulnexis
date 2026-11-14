import { useEffect, useState } from 'react'
import { useLang } from '../../lib/i18n'
import type { AgentStep, AgentTool } from '../../types'
import { Icon, type IconName } from '../ui/Icon'
import './agent.css'

export const TOOL_META: Record<AgentTool, { icon: IconName; en: string; hi: string }> = {
  plan: { icon: 'bot', en: 'Plan', hi: 'योजना' },
  github: { icon: 'github', en: 'Fetch', hi: 'प्रोजेक्ट लाना' },
  parse: { icon: 'file', en: 'Parse', hi: 'पढ़ना' },
  osv: { icon: 'search', en: 'OSV.dev', hi: 'OSV.dev' },
  enrich: { icon: 'flame', en: 'EPSS · KEV', hi: 'EPSS · KEV' },
  rank: { icon: 'sort', en: 'Rank', hi: 'प्राथमिकता' },
  gemini: { icon: 'sparkle', en: 'Gemini', hi: 'Gemini' },
  verify: { icon: 'shield-check', en: 'Verify', hi: 'जाँच' },
  report: { icon: 'report', en: 'Report', hi: 'रिपोर्ट' },
}

function secs(ms: number) {
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`
}

function useTicker(on: boolean) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!on) return
    const id = window.setInterval(() => setNow(Date.now()), 250)
    return () => window.clearInterval(id)
  }, [on])
  return now
}

/**
 * The agent's run as a vertical timeline: which tool it called, with what, what came back,
 * and what it decided next. Used live while scanning and afterwards on the Agent page.
 */
export function AgentTimeline({ steps, live = false, startedAt, compact = false }: { steps: AgentStep[]; live?: boolean; startedAt?: number; compact?: boolean }) {
  const { tr } = useLang()
  const now = useTicker(live)
  const elapsed = startedAt ? now - startedAt : 0

  return (
    <ol className={`agent-tl${live ? ' agent-tl--live' : ''}${compact ? ' agent-tl--compact' : ''}`}>
      {steps.map((s, i) => {
        const meta = TOOL_META[s.tool]
        const running = s.status === 'running'
        const ms = s.ms ?? (running && startedAt ? Math.max(0, elapsed - s.startedAt) : undefined)
        return (
          <li key={s.id} className={`agent-step agent-step--${s.status}`} style={{ animationDelay: live ? '0ms' : `${Math.min(i, 12) * 40}ms` }}>
            <span className="agent-step__rail" aria-hidden="true">
              <span className="agent-step__dot">
                {running ? <span className="spinner" /> : s.status === 'failed' ? <Icon name="x" size={11} /> : s.status === 'skipped' ? <Icon name="arrow-right" size={11} /> : <Icon name="check" size={11} />}
              </span>
            </span>
            <div className="agent-step__body">
              <div className="agent-step__head">
                <span className={`agent-tool agent-tool--${s.tool}`}>
                  <Icon name={meta.icon} size={12} />
                  {tr(meta.en, meta.hi)}
                </span>
                <span className="agent-step__title">{s.title}</span>
                <span className="agent-step__time num subtle">
                  {s.status === 'skipped' ? tr('skipped', 'छोड़ा') : s.status === 'failed' ? tr('failed', 'विफल') : ms !== undefined ? secs(ms) : ''}
                </span>
              </div>
              {(s.input || s.output) && (
                <dl className="agent-io">
                  {s.input && (
                    <div>
                      <dt>{tr('in', 'इनपुट')}</dt>
                      <dd>{s.input}</dd>
                    </div>
                  )}
                  {s.output && (
                    <div>
                      <dt>{tr('out', 'नतीजा')}</dt>
                      <dd>{s.output}</dd>
                    </div>
                  )}
                </dl>
              )}
              {s.decision && (
                <p className="agent-decision">
                  <Icon name="bot" size={13} />
                  <span>
                    <strong>{tr('Decision', 'फ़ैसला')}:</strong> {s.decision}
                  </span>
                </p>
              )}
              {s.sources && s.sources.length > 0 && (
                <p className="agent-sources">
                  {s.sources.map((src) => (
                    <a key={src.url} href={src.url} target="_blank" rel="noreferrer noopener" className="agent-source">
                      <Icon name="external" size={11} />
                      {src.label}
                    </a>
                  ))}
                </p>
              )}
            </div>
          </li>
        )
      })}
      {live && (steps.length === 0 || steps.every((s) => s.status !== 'running')) && (
        <li className="agent-step agent-step--running agent-step--ghost">
          <span className="agent-step__rail" aria-hidden="true">
            <span className="agent-step__dot">
              <span className="spinner" />
            </span>
          </span>
          <div className="agent-step__body">
            <span className="agent-step__title subtle">{tr('Agent is thinking…', 'एजेंट सोच रहा है…')}</span>
          </div>
        </li>
      )}
    </ol>
  )
}

/** Live panel shown on the scan page while the server streams steps. */
export function AgentLive({ steps, startedAt, label }: { steps: AgentStep[]; startedAt: number; label: string }) {
  const { tr } = useLang()
  const now = useTicker(true)
  const done = steps.filter((s) => s.status !== 'running').length
  return (
    <section className="agent-live" aria-labelledby="agent-live-h" aria-busy="true">
      <div className="agent-live__head">
        <div>
          <span className="eyebrow">
            <span className="agent-live__pulse" aria-hidden="true" />
            {tr('Agent working · live', 'एजेंट काम कर रहा है · लाइव')}
          </span>
          <h2 id="agent-live-h" className="truncate" title={label}>
            {label}
          </h2>
        </div>
        <div className="agent-live__clock" aria-hidden="true">
          <span className="num">{Math.max(0, Math.floor((now - startedAt) / 1000))}</span>
          <span className="subtle">s</span>
        </div>
      </div>
      <p className="sr-only" role="status" aria-live="polite">
        {steps.length ? `${steps[steps.length - 1]!.title}` : ''}
      </p>
      <p className="agent-live__meta subtle">
        {tr(
          `${done} step${done === 1 ? '' : 's'} complete. Every tool call, input and decision is shown as it happens.`,
          `${done} कदम पूरे। हर टूल, इनपुट और फ़ैसला उसी समय दिखाया जाता है।`,
        )}
      </p>
      <AgentTimeline steps={steps} live startedAt={startedAt} />
    </section>
  )
}
