import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'

// Two languages, chosen by the person and remembered in this browser.
// Strings live next to the component that shows them: tr('Fix now', 'अभी ठीक करें').
// Technical names (package names, CVE ids, commands) are never translated.

export type Lang = 'en' | 'hi'
const KEY = 'kavach:lang:v1'

interface LangCtx {
  lang: Lang
  setLang(l: Lang): void
  tr(en: string, hi: string): string
}

const Ctx = createContext<LangCtx | null>(null)

function initial(): Lang {
  try {
    const saved = localStorage.getItem(KEY)
    if (saved === 'en' || saved === 'hi') return saved
  } catch {
    /* storage unavailable */
  }
  return navigator.language?.toLowerCase().startsWith('hi') ? 'hi' : 'en'
}

export function LangProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(initial)
  useEffect(() => {
    document.documentElement.lang = lang
  }, [lang])
  const setLang = useCallback((l: Lang) => {
    setLangState(l)
    try {
      localStorage.setItem(KEY, l)
    } catch {
      /* storage unavailable */
    }
  }, [])
  const tr = useCallback((en: string, hi: string) => (lang === 'hi' ? hi : en), [lang])
  const value = useMemo(() => ({ lang, setLang, tr }), [lang, setLang, tr])
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useLang(): LangCtx {
  const c = useContext(Ctx)
  if (!c) throw new Error('useLang must be used inside <LangProvider>')
  return c
}

/** EN | हिं segmented switch. */
export function LangToggle({ compact = false }: { compact?: boolean }) {
  const { lang, setLang } = useLang()
  return (
    <div className="lang-toggle" role="group" aria-label="Language / भाषा">
      <button type="button" aria-pressed={lang === 'en'} onClick={() => setLang('en')}>
        {compact ? 'EN' : 'English'}
      </button>
      <button type="button" aria-pressed={lang === 'hi'} onClick={() => setLang('hi')} lang="hi">
        हिंदी
      </button>
    </div>
  )
}
