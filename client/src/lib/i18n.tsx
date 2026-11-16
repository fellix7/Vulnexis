import { createContext, useContext, type ReactNode } from 'react'

// English only. `tr(en, _hi)` keeps its two-argument shape so existing call sites keep compiling; the second
// argument (a Hindi string from the earlier bilingual version) is ignored. Remove it from call sites over time.

export type Lang = 'en'

interface LangCtx {
  lang: Lang
  tr(en: string, hi?: string): string
}

const value: LangCtx = { lang: 'en', tr: (en: string) => en }
const Ctx = createContext<LangCtx>(value)

export function LangProvider({ children }: { children: ReactNode }) {
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useLang(): LangCtx {
  return useContext(Ctx)
}
