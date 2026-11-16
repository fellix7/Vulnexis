import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { fetchMe, logout, logoutAll, type Me, type Plan, type Usage, type User } from '../api'
import { navigate } from '../router'

// Who is signed in, from GET /api/me. When the server has accounts off (or /api/me fails),
// `accounts` is false and the app behaves exactly as it did before accounts existed.

export interface Auth {
  accounts: boolean
  user: User | null
  plan: Plan | null
  usage: Usage | null
  /** True until the first /api/me answer (or failure). */
  loading: boolean
  /** Starts GitHub sign-in; comes back to `returnTo` (default: the current page). */
  signIn(returnTo?: string): void
  /** Ends the session, clears this browser's saved data (except the language) and goes home. */
  signOut(): Promise<void>
  /** ends every session of this account, on every device, then signs out here too */
  signOutAll(): Promise<void>
  refresh(): Promise<void>
}

const KEEP = 'vulnera:lang:v1'
const OFF: Me = { accounts: false, user: null, plan: null, usage: null }

/** Remove everything Vulnera saved in this browser except the language choice. */
export function clearSavedData() {
  try {
    const drop: string[] = []
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)
      if (k && k.startsWith('vulnera:') && k !== KEEP) drop.push(k)
    }
    drop.forEach((k) => localStorage.removeItem(k))
  } catch {
    /* storage unavailable */
  }
  try {
    for (const k of Object.keys(sessionStorage)) if (k.startsWith('vulnera:')) sessionStorage.removeItem(k)
  } catch {
    /* storage unavailable */
  }
}

const Ctx = createContext<Auth | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me>(OFF)
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(async () => {
    try {
      setMe(await fetchMe())
    } catch {
      setMe(OFF)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const signIn = useCallback((returnTo?: string) => {
    const to = returnTo ?? window.location.pathname + window.location.search
    window.location.assign(`/auth/github?returnTo=${encodeURIComponent(to)}`)
  }, [])

  const signOut = useCallback(async () => {
    try {
      await logout()
    } catch {
      /* the session may already be gone (deleted account); sign out locally anyway */
    }
    clearSavedData()
    setMe((m) => ({ ...m, user: null, plan: null, usage: null }))
    navigate('/')
    void refresh()
  }, [refresh])

  const signOutAll = useCallback(async () => {
    await logoutAll() // a failure is shown by the caller: other devices must not look signed out when they are not
    clearSavedData()
    setMe((m) => ({ ...m, user: null, plan: null, usage: null }))
    navigate('/')
    void refresh()
  }, [refresh])

  const value = useMemo<Auth>(
    () => ({ accounts: me.accounts, user: me.accounts ? me.user : null, plan: me.plan, usage: me.usage, loading, signIn, signOut, signOutAll, refresh }),
    [me, loading, signIn, signOut, signOutAll, refresh],
  )
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useAuth(): Auth {
  const a = useContext(Ctx)
  if (!a) throw new Error('useAuth must be used inside <AuthProvider>')
  return a
}
