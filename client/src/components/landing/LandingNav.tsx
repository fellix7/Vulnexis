import { useEffect, useState } from 'react'
import { Link } from '../../router'
import { LangToggle, useLang } from '../../lib/i18n'
import { Logo } from '../ui/Logo'
import { goToSection } from './scroll'

const SECTION_LINKS = [
  { id: 'agent', label: 'The agent', hi: 'एजेंट' },
  { id: 'india', label: 'Built for India', hi: 'भारत के लिए' },
  { id: 'how-it-works', label: 'How it works', hi: 'कैसे काम करता है' },
] as const

/** Id of the section currently crossing a band near the top of the viewport (null when none of the nav sections). */
function useActiveSection(ids: readonly string[]): string | null {
  const [active, setActive] = useState<string | null>(null)
  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') return
    const visible = new Set<string>()
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) visible.add(e.target.id)
          else visible.delete(e.target.id)
        }
        setActive(ids.find((id) => visible.has(id)) ?? null)
      },
      { rootMargin: '-30% 0px -60% 0px' },
    )
    for (const id of ids) {
      const el = document.getElementById(id)
      if (el) io.observe(el)
    }
    return () => io.disconnect()
  }, [ids])
  return active
}

const SECTION_IDS = SECTION_LINKS.map((l) => l.id)

export function LandingNav() {
  const active = useActiveSection(SECTION_IDS)
  const { tr } = useLang()
  return (
    <header className="lp-nav">
      <nav className="lp-wrap lp-nav__inner" aria-label="Primary">
        <a href="#top" className="lp-nav__brand" aria-label="Vulnera, back to top" onClick={(e) => goToSection(e, 'top')}>
          <Logo />
        </a>
        <ul className="lp-nav__links">
          {SECTION_LINKS.map((l) => (
            <li key={l.id}>
              <a href={`#${l.id}`} aria-current={active === l.id ? 'location' : undefined} onClick={(e) => goToSection(e, l.id)}>
                {tr(l.label, l.hi)}
              </a>
            </li>
          ))}
        </ul>
        <div className="lp-nav__actions">
          <LangToggle compact />
          <Link to="/overview" className="btn btn--ghost lp-nav__open">
            {tr('Open app', 'ऐप खोलें')}
          </Link>
          <Link to="/scan" className="btn btn--primary">
            {tr('Scan a project', 'स्कैन करें')}
          </Link>
        </div>
      </nav>
    </header>
  )
}
