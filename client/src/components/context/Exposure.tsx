import { EXPOSURE_TEXT } from '../../lib/exposure'
import { useLang } from '../../lib/i18n'
import type { ContextEvidence, Exposure } from '../../types'
import { Icon } from '../ui/Icon'
import './exposure.css'

const ICON: Record<Exposure, 'globe' | 'alert' | 'lock' | 'shield' | 'clock' | 'minus'> = {
  public: 'globe',
  unknown: 'alert',
  login: 'lock',
  internal: 'shield',
  offline: 'clock',
  unreached: 'minus',
}

export function ExposureBadge({ level, compact = false }: { level: Exposure; compact?: boolean }) {
  const { tr } = useLang()
  const t = EXPOSURE_TEXT[level]
  return (
    <span className={`xp-badge xp-badge--${t.tone}`} title={t.blurb}>
      <Icon name={ICON[level]} size={11} />
      {compact ? t.short : tr(t.en, t.hi)}
    </span>
  )
}

/** File:line quotes taken from the project's own files; each one is copied, never generated. */
export function EvidenceList({ evidence, label = 'Evidence' }: { evidence: ContextEvidence[]; label?: string }) {
  if (!evidence.length) return null
  return (
    <ul className="xp-evidence" aria-label={label}>
      {evidence.map((e) => (
        <li key={`${e.file}:${e.line}`}>
          <span className="xp-evidence__loc mono">
            {e.file}:{e.line}
          </span>
          <code className="xp-evidence__quote">{e.quote}</code>
        </li>
      ))}
    </ul>
  )
}
