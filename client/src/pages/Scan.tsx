import { useCallback, useEffect, useRef, useState } from 'react'
import { LockfileDrop } from '../components/scan/LockfileDrop'
import { MAX_REQUEST_BYTES, readLockfile, stripExtension, type LockfileInfo } from '../components/scan/lockfile'
import { AgentLive } from '../components/agent/AgentTimeline'
import { ConnectionCheck } from '../components/scan/ConnectionCheck'
import { RepoInput } from '../components/scan/RepoInput'
import { ScanSide } from '../components/scan/ScanSide'
import { SourceFolder } from '../components/scan/SourceFolder'
import { Icon } from '../components/ui/Icon'
import { Callout, PageHeader } from '../components/ui/Kit'
import { formatBytes } from '../lib/format'
import { useLang } from '../lib/i18n'
import { collectSources, type CollectedSources } from '../lib/sources'
import { Link, navigate, setSearch, useLocation } from '../router'
import { useAuth } from '../state/auth'
import { useScan, type ScanInput } from '../state/store'
import { SignInButton } from '../components/account/AccountUi'
import './scan.css'

// Survives leaving and returning to /scan while a request is in flight, so the clock and retry keep working.
const lastRun = { startedAt: 0, label: '', kind: 'upload' as 'upload' | 'sample' | 'repo', repoUrl: '' }

const SAMPLE_NAME = 'QuickNotes (sample)'

// /auth/github/callback failures land on /scan?auth=<reason>.
const AUTH_RESULT: Record<string, [string, string]> = {
  denied: ['Sign-in was cancelled.', 'साइन इन रद्द हुआ।'],
  state: ['Sign-in expired, please try again.', 'साइन इन की समय-सीमा ख़त्म, फिर कोशिश करें।'],
  email: ['Your GitHub account needs a verified email.', 'आपके GitHub खाते में सत्यापित ईमेल चाहिए।'],
  error: ['Sign-in failed, please try again.', 'साइन इन नहीं हुआ, फिर कोशिश करें।'],
}

export default function ScanPage() {
  const { current, status, error, errorCode, liveSteps, queue, cancelScan, health, healthFailed, runScan, loadDemo, dismissError } = useScan()
  const { tr } = useLang()
  const { accounts, user } = useAuth()
  const scanning = status === 'scanning'
  const uploadNeedsSignIn = accounts && !user

  // Show the OAuth callback's result once, then drop it from the address bar.
  const authParam = useLocation().search.get('auth')
  const [authResult, setAuthResult] = useState<string | null>(null)
  useEffect(() => {
    if (!authParam) return
    setAuthResult(authParam in AUTH_RESULT ? authParam : 'error')
    const qs = new URLSearchParams(window.location.search)
    qs.delete('auth')
    setSearch(qs)
  }, [authParam])

  const [info, setInfo] = useState<LockfileInfo | null>(null)
  const [lockError, setLockError] = useState<string | null>(null)
  const [reading, setReading] = useState(false)
  const [collected, setCollected] = useState<CollectedSources | null>(null)
  const [collecting, setCollecting] = useState(false)
  const [sizeError, setSizeError] = useState<string | null>(null)

  const [fallbackStart] = useState(() => Date.now())
  const mounted = useRef(true)
  const readSeq = useRef(0)
  const folderSeq = useRef(0)
  const errorBox = useRef<HTMLDivElement>(null)
  const progressBox = useRef<HTMLDivElement>(null)

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  // Bring the status panel into view when a scan starts or fails (the Run button can be far below it).
  useEffect(() => {
    if (status === 'error') errorBox.current?.scrollIntoView({ block: 'nearest' })
    if (status === 'scanning') progressBox.current?.scrollIntoView({ block: 'nearest' })
  }, [status])

  const aiOff = health !== null && !health.gemini
  const aiUnavailable = aiOff && !health.offline
  const aiUnavailableText = aiUnavailable
    ? 'No Gemini key on this server: code usage will show “Not assessed”.'
    : null

  const sourceCount = collected?.sources.length ?? 0

  const onLockfile = useCallback(async (file: File) => {
    const seq = ++readSeq.current
    setInfo(null)
    setLockError(null)
    setSizeError(null)
    setReading(true)
    const result = await readLockfile(file)
    if (seq !== readSeq.current) return
    setReading(false)
    if (result.ok) setInfo(result.info)
    else setLockError(result.error)
  }, [])

  const clearLockfile = useCallback(() => {
    readSeq.current++
    setInfo(null)
    setLockError(null)
    setSizeError(null)
    setReading(false)
  }, [])

  const onFolder = useCallback(async (files: FileList) => {
    const seq = ++folderSeq.current
    setCollected(null)
    setSizeError(null)
    setCollecting(true)
    try {
      const result = await collectSources(files)
      if (seq === folderSeq.current) setCollected(result)
    } finally {
      if (seq === folderSeq.current) setCollecting(false)
    }
  }, [])

  const clearFolder = useCallback(() => {
    folderSeq.current++
    setCollected(null)
    setCollecting(false)
    setSizeError(null)
  }, [])

  async function start(input: ScanInput, label: string, kind: 'upload' | 'sample' | 'repo') {
    lastRun.startedAt = Date.now()
    lastRun.label = label
    lastRun.kind = kind
    const ok = await runScan(input)
    // If the person moved to another page while waiting, do not pull them back.
    if (ok && mounted.current) navigate('/overview')
  }

  function runUpload() {
    if (!info) return
    // Source files are sent even without a Gemini key: the architecture map follows their imports locally on the server.
    const sources = collected?.sources ?? []
    const contextFiles = collected?.contextFiles ?? []
    const request = {
      lockfile: info.lockfile,
      ...(sources.length ? { sources } : {}),
      ...(contextFiles.length ? { contextFiles } : {}),
      ...(collected?.truncated ? { sourcesTruncated: true } : {}),
    }

    // Lockfile plus source files must fit the server's JSON body limit.
    if (info.size + (collected?.totalBytes ?? 0) > MAX_REQUEST_BYTES * 0.8) {
      const bytes = new Blob([JSON.stringify(request)]).size
      if (bytes > MAX_REQUEST_BYTES) {
        setSizeError(
          `The lockfile and source files together are ${formatBytes(bytes)}, over the server's 10 MB request limit. Remove the source folder or choose a smaller one.`,
        )
        return
      }
    }
    setSizeError(null)
    void start(
      {
        request,
        source: 'upload',
        projectName: (info.projectName ?? stripExtension(info.fileName)).trim() || info.fileName,
        fileName: info.fileName,
      },
      info.projectName ?? info.fileName,
      'upload',
    )
  }

  function runSample() {
    void start({ request: { sample: true }, source: 'sample', projectName: SAMPLE_NAME }, SAMPLE_NAME, 'sample')
  }

  function runRepo(url: string) {
    lastRun.repoUrl = url
    const name = url.replace(/^https?:\/\/(www\.)?github\.com\//, '').replace(/\/+$/, '')
    void start({ request: { repoUrl: url }, source: 'repo', projectName: name }, name, 'repo')
  }

  function exploreDemo() {
    loadDemo()
    navigate('/overview')
  }

  function retry() {
    if (lastRun.kind === 'sample') runSample()
    else if (lastRun.kind === 'repo' && lastRun.repoUrl) runRepo(lastRun.repoUrl)
    else if (info) runUpload()
    else dismissError()
  }

  const canRun = !!info && !scanning && !collecting && !reading
  const apiHint = error ? /reach the API/i.test(error) : false
  const quotaError = errorCode === 'quota_exceeded'
  const signinError = errorCode === 'signin_required'

  return (
    <div className="scan-page">
      <PageHeader
        eyebrow={tr('New scan', 'नया स्कैन')}
        title={tr('Give the agent a project', 'एजेंट को प्रोजेक्ट दें')}
        description={tr(
          'Paste a GitHub link or upload a lockfile.',
          'GitHub लिंक डालें या लॉकफ़ाइल अपलोड करें।',
        )}
      />

      {current && !scanning && (
        <p className="scan-current">
          <Icon name="layers" size={14} />
          <span className="truncate">
            Current scan: <strong>{current.projectName}</strong>
          </span>
          <Link to="/overview" className="link">
            Open overview
          </Link>
        </p>
      )}

      <div className="scan-layout">
        <div className="scan-main">
          {authResult && (
            <Callout tone={authResult === 'denied' ? 'info' : 'warn'} role="status">
              {tr(...AUTH_RESULT[authResult]!)}
            </Callout>
          )}
          {healthFailed && (
            <Callout tone="warn" role="status">
              <strong>The scan API is not reachable.</strong> Scanning needs the Vulnera server. From the project root, run <code>npm run dev</code> to start it. You can still{' '}
              <button type="button" className="link-btn" onClick={exploreDemo} disabled={scanning}>
                explore the demo data
              </button>
              .
            </Callout>
          )}
          {health?.offline && (
            <Callout tone="info">
              <strong>Offline mode.</strong> Only the sample and saved projects will scan.
            </Callout>
          )}

          {scanning && (
            <div ref={progressBox}>
              <AgentLive steps={liveSteps} startedAt={lastRun.startedAt || fallbackStart} label={lastRun.label || 'your project'} queue={queue} onCancel={cancelScan} />
            </div>
          )}

          {status === 'error' && error && (
            <div ref={errorBox}>
              <Callout tone={quotaError || signinError ? 'warn' : 'danger'} role="alert">
                <strong>
                  {quotaError
                    ? tr('Scan limit reached.', 'स्कैन सीमा पूरी हुई।')
                    : signinError
                      ? tr('Sign in to run this scan.', 'यह स्कैन चलाने के लिए साइन इन करें।')
                      : 'The scan did not finish.'}
                </strong>{' '}
                {error}
                {apiHint && (
                  <>
                    {' '}
                    Start the server with <code>npm run dev</code> from the project root, then try again.
                  </>
                )}
                <div className="cluster scan-error-actions">
                  {signinError ? (
                    <SignInButton />
                  ) : quotaError ? (
                    user && (
                      <Link to="/account" className="btn btn--sm">
                        <Icon name="user" size={14} />
                        {tr('See your usage', 'इस्तेमाल देखें')}
                      </Link>
                    )
                  ) : (
                    <button type="button" className="btn btn--sm" onClick={retry}>
                      <Icon name="refresh" size={14} />
                      Try again
                    </button>
                  )}
                  <button type="button" className="btn btn--ghost btn--sm" onClick={dismissError}>
                    Dismiss
                  </button>
                </div>
              </Callout>
              {!apiHint && !errorCode && <ConnectionCheck auto={/could not (reach|download)|blocked|network|proxy|certificate|timed? ?out/i.test(error)} />}
              {lastRun.kind === 'upload' && info && <p className="scan-hint">Your chosen files are still selected below.</p>}
            </div>
          )}

          <RepoInput disabled={scanning} onScan={runRepo} offline={!!health?.offline} />

          <div className="scan-or" role="separator">
            <span>{tr('or upload files from your computer', 'या अपने कंप्यूटर से फ़ाइल अपलोड करें')}</span>
          </div>

          {uploadNeedsSignIn ? (
            <section className="scan-signin" aria-labelledby="scan-signin-h">
              <span className="scan-signin__icon" aria-hidden="true">
                <Icon name="lock" size={16} />
              </span>
              <div className="scan-signin__body">
                <h2 id="scan-signin-h">{tr('Sign in to upload a lockfile', 'लॉकफ़ाइल अपलोड करने के लिए साइन इन करें')}</h2>
                <p>{tr('GitHub links and the sample work without an account.', 'GitHub लिंक और सैंपल बिना खाते के चलते हैं।')}</p>
              </div>
              <SignInButton className="btn btn--primary" />
            </section>
          ) : (
          <>
          <section className="scan-step" aria-labelledby="scan-s1">
            <span className="scan-step__n" aria-hidden="true">
              {info ? <Icon name="check" size={14} /> : '01'}
            </span>
            <div className="scan-step__body">
              <div className="scan-step__head">
                <h2 id="scan-s1">Lockfile</h2>
                <span className="badge">{tr('Required for upload', 'अपलोड के लिए ज़रूरी')}</span>
              </div>
              <LockfileDrop info={info} error={lockError} reading={reading} disabled={scanning} onFile={onLockfile} onClear={clearLockfile} />
            </div>
          </section>

          <section className="scan-step" aria-labelledby="scan-s2">
            <span className="scan-step__n" aria-hidden="true">
              {collected && sourceCount > 0 ? <Icon name="check" size={14} /> : '02'}
            </span>
            <div className="scan-step__body">
              <div className="scan-step__head">
                <h2 id="scan-s2">Source folder</h2>
                <span className="badge">Optional</span>
                <span className="badge badge--ai">
                  <Icon name="sparkle" size={12} />
                  Enables the AI code check
                </span>
                <span className="badge badge--info">
                  <Icon name="layers" size={12} />
                  {tr('and the architecture map', 'और आर्किटेक्चर मैप')}
                </span>
              </div>
              <p className="scan-step__lede">
                {tr('Lets the agent check code usage and map your architecture. Read, never run.', 'एजेंट कोड इस्तेमाल और आर्किटेक्चर जाँचता है। सिर्फ़ पढ़ता है।')}
              </p>
              <SourceFolder
                collected={collected}
                collecting={collecting}
                disabled={scanning}
                unavailable={aiUnavailableText}
                onFiles={onFolder}
                onClear={clearFolder}
              />
            </div>
          </section>

          <div className="scan-run">
            <button type="button" className="btn btn--primary btn--lg" onClick={runUpload} disabled={!canRun} aria-describedby="scan-run-note">
              <Icon name="play" size={14} />
              {scanning ? tr('Agent working…', 'एजेंट काम कर रहा है…') : tr('Run scan', 'स्कैन शुरू करें')}
            </button>
            <p id="scan-run-note" className="scan-run__note">
              {!info
                ? 'Add a package-lock.json first.'
                : sourceCount > 0
                  ? `Ready: ${info.fileName} and ${sourceCount.toLocaleString()} ${sourceCount === 1 ? 'file' : 'files'}.`
                  : `Ready: ${info.fileName}.`}
            </p>
          </div>
          {sizeError && (
            <div className="scan-inline scan-inline--danger" role="alert">
              <Icon name="alert" size={16} />
              <div>{sizeError}</div>
            </div>
          )}
          </>
          )}

          <section className="scan-alt" aria-labelledby="scan-alt-h">
            <h2 id="scan-alt-h">{tr('No project handy?', 'कोई प्रोजेक्ट नहीं है?')}</h2>
            <div className="scan-alt__grid">
              <div className="scan-alt__item">
                <h3>Sample project</h3>
                <p>A real scan of a deliberately outdated app.</p>
                <button type="button" className="btn" onClick={runSample} disabled={scanning}>
                  <Icon name="package" size={14} />
                  Scan the sample project
                </button>
              </div>
              <div className="scan-alt__item">
                <h3>Demo data</h3>
                <p>Instant example results, not a real scan.</p>
                <button type="button" className="btn" onClick={exploreDemo} disabled={scanning}>
                  <Icon name="beaker" size={14} />
                  Explore demo data
                </button>
              </div>
            </div>
          </section>
        </div>

        <aside className="scan-side" aria-label="About scanning">
          <ScanSide />
        </aside>
      </div>
    </div>
  )
}
