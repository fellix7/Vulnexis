import type { ReviewState } from './lib/review'
import type { AgentStep, ScanRequest, ScanResult } from './types'

/** Any non-2xx answer from the API: the server's message, the HTTP status and the machine-readable code when sent. */
export class ApiError extends Error {
  status: number
  code?: string
  constructor(status: number, error: string, code?: string) {
    super(error)
    this.status = status
    this.code = code
  }
  /** Same fields as the server's error body. */
  get error() {
    return this.message
  }
}

/** A scan result plus the id the server saved it under (signed-in scans only). */
export type ScanResponse = ScanResult & { scanId?: string }

function errorFrom(status: number, body: unknown, fallback: string): ApiError {
  const b = (body && typeof body === 'object' ? body : {}) as { error?: unknown; code?: unknown }
  return new ApiError(status, typeof b.error === 'string' && b.error ? b.error : fallback, typeof b.code === 'string' ? b.code : undefined)
}

/** Same-origin JSON call. Throws ApiError (status 0 when the server could not be reached). */
async function call<T>(method: string, url: string, body?: unknown, opts: { keepalive?: boolean } = {}): Promise<T> {
  let res: Response
  try {
    res = await fetch(url, {
      method,
      credentials: 'same-origin',
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      keepalive: opts.keepalive,
    })
  } catch {
    throw new ApiError(0, 'Could not reach the API. Is the server running?')
  }
  const text = await res.text()
  let data: unknown = null
  try {
    data = text ? JSON.parse(text) : null
  } catch {
    // non-JSON body
  }
  if (!res.ok) throw errorFrom(res.status, data, `Request failed (HTTP ${res.status}).`)
  return data as T
}

// ---- Accounts (docs/ACCOUNTS_DESIGN.md section 2) ----

export interface User {
  id: string
  login: string
  name: string | null
  email: string | null
  createdAt: string
}
export interface Plan {
  id: string
  name: string
  monthlyScans: number
  maxConcurrent: number
  maxApiKeys: number
  aiEnabled: boolean
}
export interface Usage {
  period: string
  scans: number
  limit: number
  resetsAt: string
}
export interface Me {
  accounts: boolean
  user: User | null
  plan: Plan | null
  usage: Usage | null
}

const NO_ACCOUNTS: Me = { accounts: false, user: null, plan: null, usage: null }

/** GET /api/me. Servers without accounts (404 or no `accounts` field) read as accounts off. */
export async function fetchMe(): Promise<Me> {
  try {
    const m = await call<Partial<Me> | null>('GET', '/api/me')
    if (!m || m.accounts !== true) return NO_ACCOUNTS
    return { accounts: true, user: m.user ?? null, plan: m.plan ?? null, usage: m.usage ?? null }
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) return NO_ACCOUNTS
    throw e
  }
}

export const logout = () => call<{ ok: true }>('POST', '/api/auth/logout', {})
export const deleteAccount = (confirm: string) => call<{ ok: true }>('DELETE', '/api/me', { confirm })

export interface ApiKey {
  id: string
  name: string
  keyId: string
  last4: string
  createdAt: string
  lastUsedAt: string | null
}
export const listKeys = () => call<{ keys: ApiKey[] }>('GET', '/api/keys').then((r) => r?.keys ?? [])
export const createKey = (name: string) => call<{ key: ApiKey; secret: string }>('POST', '/api/keys', { name })
export const revokeKey = (id: string) => call<{ ok: true }>('DELETE', `/api/keys/${encodeURIComponent(id)}`)

export interface ScanSummary {
  id: string
  source: string
  projectName: string
  packageCount: number
  findingCount: number
  fixNowCount: number
  aiStatus: ScanResult['aiStatus']
  createdAt: string
  expiresAt: string
}
export interface SavedScan extends ScanSummary {
  result: ScanResult
  review: ReviewState | null
}

export function listScans(cursor?: string | null): Promise<{ scans: ScanSummary[]; nextCursor: string | null }> {
  const qs = new URLSearchParams({ limit: '20' })
  if (cursor) qs.set('cursor', cursor)
  return call<{ scans?: ScanSummary[]; nextCursor?: string | null }>('GET', `/api/scans?${qs}`).then((r) => ({
    scans: r?.scans ?? [],
    nextCursor: r?.nextCursor ?? null,
  }))
}
export const getScan = (id: string) => call<SavedScan>('GET', `/api/scans/${encodeURIComponent(id)}`)
export const deleteScan = (id: string) => call<{ ok: true }>('DELETE', `/api/scans/${encodeURIComponent(id)}`)
export const putReview = (id: string, review: ReviewState, opts?: { keepalive?: boolean }) =>
  call<{ ok: true }>('PUT', `/api/scans/${encodeURIComponent(id)}/review`, { review }, opts)

export interface Health {
  ok: boolean
  offline: boolean
  gemini: boolean
}

export async function fetchHealth(): Promise<Health> {
  const r = await fetch('/api/health', { credentials: 'same-origin' })
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
  return (await r.json()) as Health
}

/** Thrown when the person pressed Cancel. Not an error to show. */
export class ScanCancelled extends Error {}

/** POST /api/scan. Throws an Error with a user-readable message on any failure. */
export async function postScan(req: ScanRequest, signal?: AbortSignal): Promise<ScanResponse> {
  let res: Response
  try {
    res = await fetch('/api/scan', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req),
      signal,
    })
  } catch {
    if (signal?.aborted) throw new ScanCancelled()
    throw new Error('Could not reach the API. Is the server running?')
  }

  const text = await res.text()
  let body: unknown = null
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    // non-JSON body; handled below
  }

  if (!res.ok) throw errorFrom(res.status, body, `Scan failed (HTTP ${res.status}).`)

  const scanId = (body as { scanId?: unknown } | null)?.scanId ?? res.headers.get('X-Scan-Id')
  return withId(normalise(body as Partial<ScanResult> | null), scanId)
}

function withId(r: ScanResult, scanId: unknown): ScanResponse {
  return typeof scanId === 'string' && scanId ? { ...r, scanId } : r
}

function normalise(r: Partial<ScanResult> | null): ScanResult {
  if (!r || !Array.isArray(r.findings) || !Array.isArray(r.plans)) {
    throw new Error('The server returned an unexpected response.')
  }
  return {
    scannedAt: r.scannedAt ?? new Date().toISOString(),
    packageCount: r.packageCount ?? 0,
    findings: r.findings,
    plans: r.plans,
    aiStatus: r.aiStatus ?? 'disabled',
    notes: Array.isArray(r.notes) ? r.notes : [],
    ...(Array.isArray(r.agent) ? { agent: r.agent } : {}),
    ...(r.repo ? { repo: r.repo } : {}),
    ...(r.context && typeof r.context === 'object' ? { context: r.context } : {}),
  }
}

/**
 * POST /api/scan/stream: the server sends one JSON object per line while the agent works
 * ({type:'step'} as each step starts and finishes, then {type:'result'} or {type:'error'}).
 */
export async function streamScan(
  req: ScanRequest,
  onStep: (step: AgentStep) => void,
  opts: { signal?: AbortSignal; onQueue?: (q: { position: number; ahead: number } | null) => void } = {},
): Promise<ScanResponse> {
  try {
    return await streamScanInner(req, onStep, opts)
  } catch (e) {
    if (opts.signal?.aborted) throw new ScanCancelled()
    throw e
  }
}

async function streamScanInner(
  req: ScanRequest,
  onStep: (step: AgentStep) => void,
  { signal, onQueue }: { signal?: AbortSignal; onQueue?: (q: { position: number; ahead: number } | null) => void },
): Promise<ScanResponse> {
  let res: Response
  try {
    res = await fetch('/api/scan/stream', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req),
      signal,
    })
  } catch {
    if (signal?.aborted) throw new ScanCancelled()
    throw new Error('Could not reach the API. Is the server running?')
  }
  if (!res.ok || !res.body) {
    // Older servers without the streaming route: fall back to the one-shot endpoint.
    if (res.status === 404) return postScan(req, signal)
    const body = await res.json().catch(() => null)
    throw errorFrom(res.status, body, `Scan failed (HTTP ${res.status}).`)
  }
  const headerId = res.headers.get('X-Scan-Id')

  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader()
  let buf = ''
  for (;;) {
    const { value, done } = await reader.read()
    if (value) buf += value
    let nl: number
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim()
      buf = buf.slice(nl + 1)
      if (!line) continue
      let msg: {
        type?: string
        step?: AgentStep
        result?: ScanResponse
        scanId?: string
        error?: string
        code?: string
        status?: number
        position?: number
        ahead?: number
      }
      try {
        msg = JSON.parse(line)
      } catch {
        continue
      }
      if (msg.type === 'queue' && typeof msg.position === 'number') onQueue?.({ position: msg.position, ahead: msg.ahead ?? msg.position - 1 })
      else if (msg.type === 'step' && msg.step) {
        onQueue?.(null)
        onStep(msg.step)
      }
      else if (msg.type === 'result') return withId(normalise(msg.result ?? null), msg.scanId ?? msg.result?.scanId ?? headerId)
      else if (msg.type === 'error') throw new ApiError(msg.status ?? 500, msg.error || 'The scan failed.', msg.code)
    }
    if (done) break
  }
  throw new Error('The connection closed before the scan finished. Try again.')
}

export interface Probe {
  id: string
  name: string
  needed: string
  ok: boolean
  ms: number
  detail: string
  advice?: string
}

/** GET /api/doctor: which services the server can reach, with advice for the ones it cannot.
 *  In production the server only answers its operator (403/404); that is reported as `restricted`, not as an error. */
export async function fetchDoctor(): Promise<{ offline: boolean; probes: Probe[]; restricted?: boolean }> {
  const r = await fetch('/api/doctor')
  if (r.status === 403 || r.status === 404) return { offline: false, probes: [], restricted: true }
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
  return (await r.json()) as { offline: boolean; probes: Probe[] }
}
