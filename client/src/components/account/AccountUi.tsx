import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react'
import { useLang } from '../../lib/i18n'
import { Link } from '../../router'
import { useAuth } from '../../state/auth'
import { Icon } from '../ui/Icon'
import './account-ui.css'

/** Letter avatar: GitHub avatars are blocked by the CSP (img-src 'self'), so the UI shows an initial. */
export function Avatar({ login, size = 24 }: { login: string; size?: number }) {
  return (
    <span className="avatar" style={{ width: size, height: size, fontSize: Math.round(size * 0.46) }} aria-hidden="true">
      {(login[0] ?? '?').toUpperCase()}
    </span>
  )
}

export function SignInButton({
  className = 'btn btn--sm',
  iconOnlySm = false,
  label,
  textClass,
}: {
  className?: string
  iconOnlySm?: boolean
  label?: string
  /** Wraps the text in a span with this class (a page's CSS can hide it on narrow screens). */
  textClass?: string
}) {
  const { signIn } = useAuth()
  const { tr } = useLang()
  const text = label ?? tr('Sign in with GitHub', 'GitHub से साइन इन करें')
  return (
    <button type="button" className={className} onClick={() => signIn()} aria-label={textClass ? text : undefined}>
      <Icon name="github" size={14} />
      {iconOnlySm ? (
        <>
          <span className="hide-sm">{text}</span>
          <span className="sr-only show-sm">{text}</span>
        </>
      ) : textClass ? (
        <span className={textClass}>{text}</span>
      ) : (
        text
      )}
    </button>
  )
}

/** "3 of 30 scans this month" from /api/me usage. Signed-in plans only. */
export function quotaText(usage: { scans: number; limit: number } | null, tr: (en: string, hi: string) => string): string | null {
  if (!usage || !(usage.limit > 0)) return null
  return tr(`${usage.scans} of ${usage.limit} scans this month`, `इस महीने ${usage.limit} में से ${usage.scans} स्कैन`)
}

/** User chip (initial + login) with a small menu: Account, Sign out. */
export function UserMenu({ placement = 'down' }: { placement?: 'down' | 'up' }) {
  const { user, signOut } = useAuth()
  const { tr } = useLang()
  const [open, setOpen] = useState(false)
  const wrap = useRef<HTMLDivElement>(null)
  const btn = useRef<HTMLButtonElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  const id = useId()

  useEffect(() => {
    if (!open) return
    menu.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus()
    const onDown = (e: PointerEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', onDown)
    return () => document.removeEventListener('pointerdown', onDown)
  }, [open])

  if (!user) return null

  function onKey(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key === 'Escape') {
      e.stopPropagation()
      setOpen(false)
      btn.current?.focus()
      return
    }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
    e.preventDefault()
    const items = [...(menu.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])]
    const i = items.indexOf(document.activeElement as HTMLElement)
    items[(i + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length]?.focus()
  }

  return (
    <div className="umenu" ref={wrap} data-placement={placement} onKeyDown={open ? onKey : undefined}>
      <button
        ref={btn}
        type="button"
        className="umenu__btn"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        aria-label={tr(`Signed in as ${user.login}`, `${user.login} के रूप में साइन इन`)}
        onClick={() => setOpen((o) => !o)}
      >
        <Avatar login={user.login} />
        <span className="umenu__login truncate">{user.login}</span>
        <Icon name="chevron-down" size={12} className="umenu__chev" />
      </button>
      {open && (
        <div className="umenu__menu" role="menu" id={id} ref={menu} aria-label={user.login}>
          <Link to="/account" role="menuitem" className="umenu__item" onClick={() => setOpen(false)}>
            <Icon name="user" size={14} />
            {tr('Account', 'खाता')}
          </Link>
          <button
            type="button"
            role="menuitem"
            className="umenu__item"
            onClick={() => {
              setOpen(false)
              void signOut()
            }}
          >
            <Icon name="logout" size={14} />
            {tr('Sign out', 'साइन आउट')}
          </button>
        </div>
      )}
    </div>
  )
}
