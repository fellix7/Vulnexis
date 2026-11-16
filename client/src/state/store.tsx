import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  ApiError,
  deleteScan as apiDeleteScan,
  fetchHealth,
  getScan,
  listScans,
  putReview,
  ScanCancelled,
  streamScan,
  type Health,
  type SavedScan,
  type ScanSummary,
} from '../api'
import { effectiveTier, findingKey, type Review, type ReviewState } from '../lib/review'
import { useAuth } from './auth'
import { MOCK_RESULT } from '../mock'
import type { AgentStep, ScanRequest, ScanResult, SourceFile } from '../types'

// One scan the user can look at. 'demo' records are illustrative data and never enter history.
export type ScanSource = 'upload' | 'sample' | 'repo' | 'demo'

export interface ScanRecord {
  id: string
  source: ScanSource
  projectName: string
  fileName?: string
  sourceFileCount: number // source files sent for the AI code check (0 = none, -1 = sample, -2 = unknown: a scan saved to the account)
  result: ScanResult
  review: ReviewState
  savedAt: string
  /** Saved to the signed-in account (the id is the server's scan id); reviews are sent to the server. */
  remote?: boolean
}

/** One row of scan history: built from a local record, or a server summary (full record loaded on demand). */
export interface HistoryItem {
  id: string
  source: ScanSource
  projectName: string
  fileName?: string
  scannedAt: string
  packageCount: number
  findingCount: number
  fixNowCount: number
  aiStatus: ScanResult['aiStatus']
  /** Findings the AI assessed; unknown for server summaries. */
  aiAssessed?: number
  expiresAt?: string
}

export interface RemoteHistory {
  loading: boolean
  loaded: boolean
  error: string | null
  nextCursor: string | null
}

export interface ScanInput {
  request: ScanRequest
  source: 'upload' | 'sample' | 'repo'
  projectName: string
  fileName?: string
}

export interface ScanStore {
  current: ScanRecord | null
  status: 'idle' | 'scanning' | 'error'
  error: string | null
  /** Server error code of the last failed scan ('quota_exceeded', 'signin_required'), if any. */
  errorCode: string | null
  /** Agent steps of the running scan, as the server streams them. */
  liveSteps: AgentStep[]
  /** Set while the scan waits for a free slot on the server (position 1 = next). */
  queue: { position: number; ahead: number } | null
  /** Stops the running or waiting scan and returns to idle without an error. */
  cancelScan(): void
  /** Real scans, newest first. Persisted in this browser only (signed out). */
  history: ScanRecord[]
  /** Signed in: history lives on the server and never touches localStorage. */
  remote: boolean
  /** Rows for the history list: local records, or server summaries when signed in. */
  historyItems: HistoryItem[]
  remoteHistory: RemoteHistory
  loadMoreHistory(): void
  /** Full record: from memory, local history or the server (cached in memory). */
  loadScan(id: string): Promise<ScanRecord>
  /** Already-loaded record, without fetching. */
  loadedScan(id: string): ScanRecord | undefined
  /** Source files of the current upload, kept in memory only (never persisted) for code context. */
  sources: SourceFile[] | null
  health: Health | null
  healthFailed: boolean
  runScan(input: ScanInput): Promise<boolean>
  loadDemo(): void
  openScan(id: string): Promise<boolean>
  closeScan(): void
  deleteScan(id: string): Promise<void>
  clearHistory(): void
  setReview(key: string, next: Review): void
  dismissError(): void
}

const HISTORY_KEY = 'vulnera:history:v1'
const CURRENT_KEY = 'vulnera:current:v1'
const REMOTE_CURRENT_KEY = 'vulnera:current-remote:v1' // sessionStorage, signed in: only the open scan's id
const REVIEW_DEBOUNCE_MS = 800
const SOURCES = ['upload', 'sample', 'repo'] as const
const DEMO_ID = 'demo'
const MAX_HISTORY = 8

const DEMO_RECORD = (): ScanRecord => ({
  id: DEMO_ID,
  source: 'demo',
  projectName: 'Demo project',
  sourceFileCount: 0,
  result: MOCK_RESULT,
  review: {},
  savedAt: MOCK_RESULT.scannedAt,
})

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : fallback
  } catch {
    return fallback
  }
}

const LONG = 1000

/** Smaller copy for localStorage: advisory `details` cut to its opening (enough for the risk category and the finding page), long AI reasoning cut. */
function slim(r: ScanRecord): ScanRecord {
  return {
    ...r,
    result: {
      ...r.result,
      findings: r.result.findings.map((f) => ({
        ...f,
        advisory: { ...f.advisory, details: f.advisory.details.length > LONG ? `${f.advisory.details.slice(0, LONG)}…` : f.advisory.details },
        ...(f.ai && f.ai.reasoning.length > LONG ? { ai: { ...f.ai, reasoning: `${f.ai.reasoning.slice(0, LONG)}…` } } : {}),
      })),
    },
  }
}

/** Save history, dropping the oldest scans one at a time if the browser's storage quota is exceeded. */
function writeHistory(list: ScanRecord[]) {
  if (list.length === 0) {
    // Nothing to keep: leave no key behind (an empty "[]" is still a trace in a signed-out or shared browser).
    try {
      localStorage.removeItem(HISTORY_KEY)
    } catch {
      /* storage unavailable */
    }
    return
  }
  const items = list.slice(0, MAX_HISTORY).map(slim)
  for (;;) {
    try {
      localStorage.setItem(HISTORY_KEY, JSON.stringify(items))
      return
    } catch {
      if (items.length === 0) return // storage unavailable
      items.pop()
    }
  }
}

const fixNowOf = (r: ScanRecord) => r.result.findings.filter((f) => effectiveTier(f, r.review[findingKey(f)]) === 'FIX_NOW').length

export function toHistoryItem(r: ScanRecord): HistoryItem {
  return {
    id: r.id,
    source: r.source,
    projectName: r.projectName,
    fileName: r.fileName,
    scannedAt: r.result.scannedAt,
    packageCount: r.result.packageCount,
    findingCount: r.result.findings.length,
    fixNowCount: fixNowOf(r),
    aiStatus: r.result.aiStatus,
    aiAssessed: r.result.findings.filter((f) => f.ai).length,
  }
}

function fromSummary(s: ScanSummary): HistoryItem {
  return {
    id: s.id,
    source: (SOURCES as readonly string[]).includes(s.source) ? (s.source as ScanSource) : 'upload',
    projectName: s.projectName || 'Untitled scan',
    scannedAt: s.createdAt,
    packageCount: s.packageCount,
    findingCount: s.findingCount,
    fixNowCount: s.fixNowCount,
    aiStatus: s.aiStatus,
    expiresAt: s.expiresAt,
  }
}

function fromSaved(s: SavedScan): ScanRecord {
  const r = s.result
  const result: ScanResult = {
    ...r,
    findings: Array.isArray(r?.findings) ? r.findings : [],
    plans: Array.isArray(r?.plans) ? r.plans : [],
    notes: Array.isArray(r?.notes) ? r.notes : [],
    scannedAt: r?.scannedAt ?? s.createdAt,
    aiStatus: r?.aiStatus ?? s.aiStatus ?? 'disabled',
    packageCount: r?.packageCount ?? s.packageCount ?? 0,
  }
  return {
    id: s.id,
    source: fromSummary(s).source,
    projectName: s.projectName || 'Untitled scan',
    sourceFileCount: result.repo?.sourceFiles ?? -2,
    result,
    review: s.review && typeof s.review === 'object' ? s.review : {},
    savedAt: s.createdAt,
    remote: true,
  }
}

function sessionSet(key: string, value: string | null) {
  try {
    if (value) sessionStorage.setItem(key, value)
    else sessionStorage.removeItem(key)
  } catch {
    /* storage unavailable */
  }
}

const EMPTY_REMOTE: RemoteHistory = { loading: false, loaded: false, error: null, nextCursor: null }

function writeCurrent(id: string | null) {
  try {
    if (id) localStorage.setItem(CURRENT_KEY, id)
    else localStorage.removeItem(CURRENT_KEY)
  } catch {
    /* storage unavailable */
  }
}

function isRecord(x: unknown): x is ScanRecord {
  const r = x as ScanRecord
  return !!r && typeof r.id === 'string' && !!r.result && Array.isArray(r.result.findings) && Array.isArray(r.result.plans)
}

const Ctx = createContext<ScanStore | null>(null)

export function ScanProvider({ children }: { children: ReactNode }) {
  const auth = useAuth()
  const remote = auth.accounts && !!auth.user
  // Until /api/me answers we do not know whether this browser is signed in: write nothing to storage yet.
  const authKnownRef = useRef(!auth.loading)
  authKnownRef.current = !auth.loading
  const userId = auth.user?.id ?? null
  const remoteRef = useRef(remote)
  remoteRef.current = remote
  const refreshAuth = auth.refresh
  const accountsRef = useRef(auth.accounts)
  accountsRef.current = auth.accounts

  const [history, setHistory] = useState<ScanRecord[]>(() => readJson<unknown[]>(HISTORY_KEY, []).filter(isRecord))
  const [current, setCurrent] = useState<ScanRecord | null>(() => {
    const id = safeGet(CURRENT_KEY)
    if (id === DEMO_ID) return DEMO_RECORD()
    return history.find((r) => r.id === id) ?? null
  })
  const [status, setStatus] = useState<ScanStore['status']>('idle')
  const [error, setError] = useState<string | null>(null)
  const [errorCode, setErrorCode] = useState<string | null>(null)
  const [remoteItems, setRemoteItems] = useState<HistoryItem[]>([])
  const [remoteHistory, setRemoteHistory] = useState<RemoteHistory>(EMPTY_REMOTE)
  const cache = useRef(new Map<string, ScanRecord>())
  const currentRef = useRef(current)
  currentRef.current = current
  const pending = useRef(new Map<string, { timer: number; review: ReviewState }>())
  const [liveSteps, setLiveSteps] = useState<AgentStep[]>([])
  const [queue, setQueue] = useState<ScanStore['queue']>(null)
  const abortRef = useRef<AbortController | null>(null)
  const [sources, setSources] = useState<SourceFile[] | null>(null)
  const [health, setHealth] = useState<Health | null>(null)
  const [healthFailed, setHealthFailed] = useState(false)

  useEffect(() => {
    fetchHealth()
      .then(setHealth)
      .catch(() => setHealthFailed(true))
  }, [])

  // At most one write a second: review clicks change history often.
  const lastWrite = useRef(0)
  const latest = useRef(history)
  latest.current = history
  useEffect(() => {
    if (remoteRef.current || !authKnownRef.current) return
    const wait = Math.max(0, lastWrite.current + 1000 - Date.now())
    const id = window.setTimeout(() => {
      if (remoteRef.current || !authKnownRef.current) return
      lastWrite.current = Date.now()
      writeHistory(latest.current)
    }, wait)
    return () => window.clearTimeout(id)
  }, [history])
  useEffect(() => {
    const flush = () => {
      if (!remoteRef.current && authKnownRef.current) writeHistory(latest.current)
      // Review changes still waiting for the debounce: send them now, surviving the page unload.
      for (const [id, p] of pending.current) {
        window.clearTimeout(p.timer)
        putReview(id, p.review, { keepalive: true }).catch(() => {})
      }
      pending.current.clear()
    }
    window.addEventListener('pagehide', flush)
    return () => window.removeEventListener('pagehide', flush)
  }, [])

  const runScan = useCallback(async (input: ScanInput) => {
    setStatus('scanning')
    setError(null)
    const withSources = input.request.sources ?? []
    setLiveSteps([])
    setQueue(null)
    const ctl = new AbortController()
    abortRef.current = ctl
    try {
      const request = remoteRef.current ? { ...input.request, meta: { projectName: input.projectName.slice(0, 200) } } : input.request
      const { scanId, ...result } = await streamScan(
        request,
        (step) =>
          setLiveSteps((list) => {
            const i = list.findIndex((s) => s.id === step.id)
            if (i === -1) return [...list, step]
            const next = list.slice()
            next[i] = step
            return next
          }),
        { signal: ctl.signal, onQueue: setQueue },
      )
      setQueue(null)
      const saved = remoteRef.current && !!scanId
      const record: ScanRecord = {
        id: saved ? scanId! : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
        source: input.source,
        projectName: input.projectName,
        fileName: input.fileName,
        sourceFileCount: input.source === 'upload' ? withSources.length : (result.repo?.sourceFiles ?? -1),
        result,
        review: {},
        savedAt: new Date().toISOString(),
        ...(saved ? { remote: true } : {}),
      }
      setCurrent(record)
      setSources(withSources.length ? withSources : null)
      if (saved) {
        cache.current.set(record.id, record)
        setRemoteItems((list) => [toHistoryItem(record), ...list.filter((r) => r.id !== record.id)])
        sessionSet(REMOTE_CURRENT_KEY, record.id)
      } else if (remoteRef.current) {
        // Signed in but not saved (the sample scan): open it, keep it out of history.
        sessionSet(REMOTE_CURRENT_KEY, null)
      } else {
        setHistory((h) => [record, ...h.filter((r) => r.id !== record.id)].slice(0, MAX_HISTORY))
        writeCurrent(record.id)
      }
      setStatus('idle')
      if (accountsRef.current) void refreshAuth()
      return true
    } catch (e) {
      setQueue(null)
      if (e instanceof ScanCancelled) {
        setStatus('idle')
        return false
      }
      setError(e instanceof Error ? e.message : 'Unknown error')
      const code = e instanceof ApiError ? (e.code ?? null) : null
      setErrorCode(code)
      if (code === 'quota_exceeded') void refreshAuth()
      setStatus('error')
      return false
    }
  }, [refreshAuth])

  const cancelScan = useCallback(() => abortRef.current?.abort(), [])

  /** Where the open scan's id is remembered: this browser (signed out) or this tab only (signed in). */
  const rememberCurrent = useCallback((id: string | null) => {
    if (remoteRef.current) sessionSet(REMOTE_CURRENT_KEY, id)
    else writeCurrent(id)
  }, [])

  const loadDemo = useCallback(() => {
    setCurrent(DEMO_RECORD())
    setSources(null)
    rememberCurrent(DEMO_ID)
  }, [rememberCurrent])

  const loadedScan = useCallback(
    (id: string) => cache.current.get(id) ?? (remoteRef.current ? undefined : history.find((x) => x.id === id)),
    [history],
  )

  const loadScan = useCallback(
    async (id: string) => {
      const have = loadedScan(id)
      if (have) return have
      if (!remoteRef.current) throw new Error('This scan is no longer saved.')
      const rec = fromSaved(await getScan(id))
      cache.current.set(id, rec)
      return rec
    },
    [loadedScan],
  )

  const openScan = useCallback(
    async (id: string) => {
      if (id === DEMO_ID) {
        loadDemo()
        return true
      }
      let r: ScanRecord
      try {
        r = await loadScan(id)
      } catch {
        return false
      }
      setCurrent(r)
      setSources(null)
      rememberCurrent(r.id)
      return true
    },
    [loadDemo, loadScan, rememberCurrent],
  )

  const closeScan = useCallback(() => {
    setCurrent(null)
    setSources(null)
    rememberCurrent(null)
  }, [rememberCurrent])

  const deleteScan = useCallback(
    async (id: string) => {
      if (remoteRef.current) {
        await apiDeleteScan(id)
        cache.current.delete(id)
        const p = pending.current.get(id)
        if (p) window.clearTimeout(p.timer)
        pending.current.delete(id)
        setRemoteItems((list) => list.filter((r) => r.id !== id))
      } else {
        setHistory((h) => h.filter((r) => r.id !== id))
      }
      if (currentRef.current?.id === id) {
        setCurrent(null)
        rememberCurrent(null)
      }
    },
    [rememberCurrent],
  )

  const fetchPage = useCallback(async (cursor: string | null) => {
    setRemoteHistory((h) => ({ ...h, loading: true, error: null }))
    try {
      const page = await listScans(cursor)
      const items = page.scans.map(fromSummary)
      setRemoteItems((list) => (cursor ? [...list, ...items.filter((i) => !list.some((x) => x.id === i.id))] : items))
      setRemoteHistory({ loading: false, loaded: true, error: null, nextCursor: page.nextCursor })
    } catch (e) {
      setRemoteHistory((h) => ({ ...h, loading: false, error: e instanceof Error ? e.message : 'Could not load your scans.' }))
    }
  }, [])

  const loadMoreHistory = useCallback(() => {
    if (!remoteRef.current) return
    if (remoteHistory.loading) return
    if (remoteHistory.loaded && !remoteHistory.nextCursor && !remoteHistory.error) return
    void fetchPage(remoteHistory.loaded ? remoteHistory.nextCursor : null)
  }, [fetchPage, remoteHistory])

  // Sign-in state known, or changed: signed-in history comes from the server; signing out resets memory state.
  const seenUser = useRef<string | null | undefined>(undefined)
  useEffect(() => {
    if (auth.loading) return
    const prev = seenUser.current
    seenUser.current = userId
    if (prev === userId) return
    if (prev !== undefined) {
      // A different person (or nobody) now: forget everything held in memory.
      for (const p of pending.current.values()) window.clearTimeout(p.timer)
      pending.current.clear()
      cache.current.clear()
      setRemoteItems([])
      setRemoteHistory(EMPTY_REMOTE)
      setCurrent(null)
      setSources(null)
      setError(null)
      setErrorCode(null)
      setStatus((s) => (s === 'error' ? 'idle' : s))
      setHistory(readJson<unknown[]>(HISTORY_KEY, []).filter(isRecord))
    }
    if (!remote) return
    // Signed in: a scan restored from this browser's local history is not the account's; drop it.
    setCurrent((c) => (c && c.source !== 'demo' && !c.remote ? null : c))
    void fetchPage(null)
    let restore: string | null = null
    try {
      restore = sessionStorage.getItem(REMOTE_CURRENT_KEY)
    } catch {
      /* storage unavailable */
    }
    if (restore === DEMO_ID) setCurrent(DEMO_RECORD())
    else if (restore) {
      const id = restore
      getScan(id)
        .then((s) => {
          const rec = fromSaved(s)
          cache.current.set(id, rec)
          setCurrent((c) => c ?? rec)
        })
        .catch(() => sessionSet(REMOTE_CURRENT_KEY, null))
    }
  }, [auth.loading, userId, remote, fetchPage])

  const clearHistory = useCallback(() => {
    setHistory([])
    setCurrent((c) => {
      if (c && c.source !== 'demo') {
        writeCurrent(null)
        return null
      }
      return c
    })
  }, [])

  const setReview = useCallback((key: string, next: Review) => {
    const c = currentRef.current
    if (!c) return
    const updated = { ...c, review: { ...c.review, [key]: next } }
    currentRef.current = updated
    setCurrent(updated)
    if (c.source === 'demo') return
    if (c.remote) {
      cache.current.set(c.id, updated)
      const fixNowCount = fixNowOf(updated)
      setRemoteItems((list) => list.map((r) => (r.id === c.id ? { ...r, fixNowCount } : r)))
      // Debounced: one PUT with the whole review after the reviewer pauses.
      const old = pending.current.get(c.id)
      if (old) window.clearTimeout(old.timer)
      const timer = window.setTimeout(() => {
        pending.current.delete(c.id)
        putReview(c.id, updated.review).catch(() => {
          /* best effort; the decision stays in memory for this session */
        })
      }, REVIEW_DEBOUNCE_MS)
      pending.current.set(c.id, { timer, review: updated.review })
    } else if (!remoteRef.current) {
      setHistory((h) => h.map((r) => (r.id === c.id ? updated : r)))
    }
  }, [])

  const dismissError = useCallback(() => {
    setError(null)
    setErrorCode(null)
    setStatus('idle')
  }, [])

  const historyItems = useMemo(() => (remote ? remoteItems : history.map(toHistoryItem)), [remote, remoteItems, history])

  const value = useMemo<ScanStore>(
    () => ({
      current,
      status,
      error,
      errorCode,
      liveSteps,
      queue,
      cancelScan,
      history,
      remote,
      historyItems,
      remoteHistory,
      loadMoreHistory,
      loadScan,
      loadedScan,
      sources,
      health,
      healthFailed,
      runScan,
      loadDemo,
      openScan,
      closeScan,
      deleteScan,
      clearHistory,
      setReview,
      dismissError,
    }),
    [
      current,
      status,
      error,
      errorCode,
      liveSteps,
      queue,
      cancelScan,
      history,
      remote,
      historyItems,
      remoteHistory,
      loadMoreHistory,
      loadScan,
      loadedScan,
      sources,
      health,
      healthFailed,
      runScan,
      loadDemo,
      openScan,
      closeScan,
      deleteScan,
      clearHistory,
      setReview,
      dismissError,
    ],
  )
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

function safeGet(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

export function useScan(): ScanStore {
  const s = useContext(Ctx)
  if (!s) throw new Error('useScan must be used inside <ScanProvider>')
  return s
}

export const SOURCE_LABEL: Record<ScanSource, string> = {
  upload: 'Live scan',
  sample: 'Sample project scan',
  repo: 'GitHub repo scan',
  demo: 'Demo data',
}
