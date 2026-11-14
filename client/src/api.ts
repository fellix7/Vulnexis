import type { AgentStep, ScanRequest, ScanResult } from './types'

export interface Health {
  ok: boolean
  offline: boolean
  gemini: boolean
}

export async function fetchHealth(): Promise<Health> {
  const r = await fetch('/api/health')
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
  return (await r.json()) as Health
}

/** POST /api/scan. Throws an Error with a user-readable message on any failure. */
export async function postScan(req: ScanRequest): Promise<ScanResult> {
  let res: Response
  try {
    res = await fetch('/api/scan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req),
    })
  } catch {
    throw new Error('Could not reach the API. Is the server running?')
  }

  const text = await res.text()
  let body: unknown = null
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    // non-JSON body; handled below
  }

  if (!res.ok) {
    const msg =
      body && typeof body === 'object' && 'error' in body && typeof (body as { error: unknown }).error === 'string'
        ? (body as { error: string }).error
        : `Scan failed (HTTP ${res.status}).`
    throw new Error(msg)
  }

  const r = body as Partial<ScanResult> | null
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
  }
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
  }
}

/**
 * POST /api/scan/stream: the server sends one JSON object per line while the agent works
 * ({type:'step'} as each step starts and finishes, then {type:'result'} or {type:'error'}).
 */
export async function streamScan(req: ScanRequest, onStep: (step: AgentStep) => void): Promise<ScanResult> {
  let res: Response
  try {
    res = await fetch('/api/scan/stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req),
    })
  } catch {
    throw new Error('Could not reach the API. Is the server running?')
  }
  if (!res.ok || !res.body) {
    // Older servers without the streaming route: fall back to the one-shot endpoint.
    if (res.status === 404) return postScan(req)
    const body = (await res.json().catch(() => null)) as { error?: unknown } | null
    throw new Error(typeof body?.error === 'string' ? body.error : `Scan failed (HTTP ${res.status}).`)
  }

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
      let msg: { type?: string; step?: AgentStep; result?: ScanResult; error?: string }
      try {
        msg = JSON.parse(line)
      } catch {
        continue
      }
      if (msg.type === 'step' && msg.step) onStep(msg.step)
      else if (msg.type === 'result') return normalise(msg.result ?? null)
      else if (msg.type === 'error') throw new Error(msg.error || 'The scan failed.')
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

/** GET /api/doctor: which services the server can reach, with advice for the ones it cannot. */
export async function fetchDoctor(): Promise<{ offline: boolean; probes: Probe[] }> {
  const r = await fetch('/api/doctor')
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
  return (await r.json()) as { offline: boolean; probes: Probe[] }
}
