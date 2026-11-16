import { useEffect, useRef, useState } from 'react'
import { formatScanTime } from '../../lib/selectors'
import { Link, navigate } from '../../router'
import { useAuth } from '../../state/auth'
import { useScan, type HistoryItem } from '../../state/store'
import { SourceBadge } from '../ui/Badges'
import { Icon } from '../ui/Icon'
import { Callout, EmptyState } from '../ui/Kit'
import { AiStatusTag } from './AiStatusTag'

interface Props {
  /** Saved scans, newest first (demo data is never in here). */
  scans: HistoryItem[]
  currentId: string | null
  picked: string[]
  onTogglePick: (id: string) => void
  onCompareSelected: () => void
}

export function History({ scans, currentId, picked, onTogglePick, onCompareSelected }: Props) {
  const { openScan, deleteScan, clearHistory, remote, remoteHistory, loadMoreHistory } = useScan()
  const authLoading = useAuth().loading
  const [busy, setBusy] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  // 'all' = clear history is awaiting confirmation; otherwise the id of the scan awaiting delete confirmation.
  const [confirm, setConfirm] = useState<string | 'all' | null>(null)
  const heading = useRef<HTMLHeadingElement>(null)

  // A pending confirmation expires, and Escape cancels it.
  useEffect(() => {
    if (!confirm) return
    const t = window.setTimeout(() => setConfirm(null), 6000)
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setConfirm(null)
    window.addEventListener('keydown', onKey)
    return () => {
      window.clearTimeout(t)
      window.removeEventListener('keydown', onKey)
    }
  }, [confirm])

  async function open(id: string) {
    setBusy(id)
    setActionError(null)
    const ok = await openScan(id)
    setBusy(null)
    if (ok) navigate('/overview')
    else setActionError('Could not open this scan. It may have expired or been deleted.')
  }

  async function remove(id: string) {
    setBusy(id)
    setActionError(null)
    try {
      await deleteScan(id)
      heading.current?.focus()
    } catch (e) {
      setActionError(e instanceof Error ? e.message : 'Could not delete this scan.')
    } finally {
      setBusy(null)
      setConfirm(null)
    }
  }

  function clearAll() {
    clearHistory()
    setConfirm(null)
    heading.current?.focus()
  }

  const full = picked.length >= 2

  return (
    <section className="panel" aria-labelledby="rep-history-h">
      <div className="panel__head">
        <h2 id="rep-history-h" ref={heading} tabIndex={-1}>
          Scan history
          {scans.length > 0 && <span className="subtle num rep-count"> {scans.length}</span>}
        </h2>
        {scans.length > 0 && !remote && (
          <div className="cluster">
            <button
              type="button"
              className={`btn btn--sm ${confirm === 'all' ? 'btn--danger' : 'btn--ghost'}`}
              onClick={() => (confirm === 'all' ? clearAll() : setConfirm('all'))}
            >
              <Icon name="trash" size={14} />
              {confirm === 'all' ? `Confirm: clear ${scans.length} ${scans.length === 1 ? 'scan' : 'scans'}` : 'Clear history'}
            </button>
            {confirm === 'all' && (
              <button type="button" className="btn btn--sm btn--ghost" onClick={() => setConfirm(null)}>
                Cancel
              </button>
            )}
          </div>
        )}
      </div>

      <p className="rep-note subtle">
        {remote ? 'Saved to your account for 90 days. Source code is never stored.' : 'Saved in this browser only.'}
      </p>
      {actionError && (
        <div className="rep-hist-msg">
          <Callout tone="danger" role="alert">
            {actionError}
          </Callout>
        </div>
      )}
      <span className="sr-only" role="status" aria-live="polite">
        {confirm ? 'Press the confirm button to delete, or Escape to cancel.' : ''}
      </span>

      {authLoading || (remote && !remoteHistory.loaded) ? (
        remoteHistory.error && !authLoading ? (
          <div className="rep-hist-msg">
            <Callout tone="danger" role="alert">
              {remoteHistory.error}{' '}
              <button type="button" className="link-btn" onClick={loadMoreHistory}>
                Try again
              </button>
            </Callout>
          </div>
        ) : (
          <p className="rep-hist-msg rep-loading subtle" role="status">
            <span className="spinner" aria-hidden="true" />
            Loading your scans…
          </p>
        )
      ) : scans.length === 0 ? (
        <EmptyState
          icon="history"
          title="No saved scans yet"
          actions={
            <Link to="/scan" className="btn btn--primary">
              <Icon name="upload" size={14} />
              Scan a project
            </Link>
          }
        >
          Your scans appear here.
        </EmptyState>
      ) : (
        <>
          <div className="rep-hist">
            <div className="table-wrap">
              <table className="dtable rep-table" role="table">
                <caption className="sr-only">Saved scans, newest first</caption>
                <thead role="rowgroup">
                  <tr role="row">
                    <th scope="col" role="columnheader">Project</th>
                    <th scope="col" role="columnheader">Source</th>
                    <th scope="col" role="columnheader">Scanned</th>
                    <th scope="col" role="columnheader" className="num">
                      Packages
                    </th>
                    <th scope="col" role="columnheader" className="num">
                      Findings
                    </th>
                    <th scope="col" role="columnheader" className="num">
                      Fix now
                    </th>
                    <th scope="col" role="columnheader">AI check</th>
                    <th scope="col" role="columnheader">
                      <span className="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody role="rowgroup">
                  {scans.map((r) => {
                    const isCurrent = r.id === currentId
                    const isPicked = picked.includes(r.id)
                    const when = formatScanTime(r.scannedAt)
                    const fixNow = r.fixNowCount
                    return (
                      <tr key={r.id} role="row" className={isCurrent ? 'is-current' : undefined}>
                        <th scope="row" role="rowheader" className="rep-projcell">
                          <div className="rep-proj">
                            <label className="check rep-proj__pick">
                              <input type="checkbox" checked={isPicked} disabled={!isPicked && full} onChange={() => onTogglePick(r.id)} />
                              <span className="sr-only">
                                Select {r.projectName}, {when}, to compare
                              </span>
                            </label>
                            <div className="rep-proj__txt">
                              <span className="rep-proj__line">
                                <span className="rep-proj__name">{r.projectName}</span>
                                {isCurrent && <span className="badge badge--accent">Current</span>}
                              </span>
                              {r.fileName && <span className="subtle mono rep-proj__file">{r.fileName}</span>}
                            </div>
                          </div>
                        </th>
                        <td role="cell" data-label="Source">
                          <SourceBadge source={r.source} />
                        </td>
                        <td role="cell" data-label="Scanned" className="num">
                          {when}
                        </td>
                        <td role="cell" data-label="Packages" className="num mono">
                          {r.packageCount}
                        </td>
                        <td role="cell" data-label="Findings" className="num mono">
                          {r.findingCount}
                        </td>
                        <td role="cell" data-label="Fix now" className="num mono">
                          {fixNow > 0 ? <span className="rep-hot">{fixNow}</span> : fixNow}
                        </td>
                        <td role="cell" data-label="AI check">
                          <AiStatusTag aiStatus={r.aiStatus} assessed={r.aiAssessed} />
                        </td>
                        <td role="cell" data-label="Actions" className="rep-actions">
                          <button type="button" className="btn btn--sm" onClick={() => void open(r.id)} disabled={busy === r.id}>
                            {busy === r.id && confirm !== r.id && <span className="spinner" aria-hidden="true" />}
                            Open<span className="sr-only"> {r.projectName}, {when}</span>
                          </button>
                          <button
                            type="button"
                            className={`btn btn--sm ${confirm === r.id ? 'btn--danger' : 'btn--ghost'}`}
                            disabled={busy === r.id}
                            onClick={() => (confirm === r.id ? void remove(r.id) : setConfirm(r.id))}
                          >
                            <Icon name="trash" size={14} />
                            {confirm === r.id ? 'Confirm delete' : 'Delete'}
                            <span className="sr-only">
                              {' '}
                              {r.projectName}, {when}
                            </span>
                          </button>
                          {confirm === r.id && (
                            <button type="button" className="btn btn--sm btn--ghost" onClick={() => setConfirm(null)}>
                              Cancel
                            </button>
                          )}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </div>
          {remote && (remoteHistory.nextCursor || remoteHistory.error) && (
            <div className="rep-more">
              {remoteHistory.error && <span className="subtle">{remoteHistory.error}</span>}
              <button type="button" className="btn btn--sm" onClick={loadMoreHistory} disabled={remoteHistory.loading}>
                {remoteHistory.loading ? <span className="spinner" aria-hidden="true" /> : <Icon name="arrow-down" size={14} />}
                Load more
              </button>
            </div>
          )}
          <div className="rep-pickbar">
            <p className="muted" aria-live="polite">
              {picked.length === 2
                ? '2 of 2 scans selected. Untick one to pick a different scan.'
                : `Tick two scans to compare them (${picked.length} of 2 selected).`}
            </p>
            <button type="button" className="btn btn--sm" disabled={picked.length !== 2} onClick={onCompareSelected}>
              <Icon name="compare" size={14} />
              Compare selected
            </button>
          </div>
        </>
      )}
    </section>
  )
}
