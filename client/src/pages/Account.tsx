import { useEffect, useRef, useState, type FormEvent } from 'react'
import { ApiError, createKey, deleteAccount, listKeys, revokeKey, type ApiKey, type Plan, type Usage, type User } from '../api'
import { Avatar, SignInButton } from '../components/account/AccountUi'
import { Icon } from '../components/ui/Icon'
import { Callout, CommandBlock, EmptyState, PageHeader } from '../components/ui/Kit'
import { useLang } from '../lib/i18n'
import { useAuth } from '../state/auth'
import './account.css'

const day = (iso: string | null | undefined, timeZone?: string) => {
  if (!iso) return null
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric', timeZone })
}
// Quota periods are Indian calendar months (docs/ACCOUNTS_DESIGN.md section 3).
const IST = 'Asia/Kolkata'
const message = (e: unknown, fallback: string) => (e instanceof Error && e.message ? e.message : fallback)

export default function AccountPage() {
  const { accounts, user, plan, usage, loading } = useAuth()
  const { tr } = useLang()

  if (loading) {
    return (
      <>
        <PageHeader title={tr('Account', 'खाता')} />
        <div className="panel acct-loading" role="status">
          <span className="spinner" aria-hidden="true" />
          {tr('Loading your account…', 'खाता लोड हो रहा है…')}
        </div>
      </>
    )
  }
  if (!accounts || !user) {
    return (
      <>
        <PageHeader title={tr('Account', 'खाता')} />
        <div className="panel">
          {accounts ? (
            <EmptyState icon="user" title={tr('Sign in to see your account', 'खाता देखने के लिए साइन इन करें')} actions={<SignInButton className="btn btn--primary" />}>
              {tr('Saved scans, quota and API keys live here.', 'सेव स्कैन, कोटा और API कुंजियाँ यहाँ हैं।')}
            </EmptyState>
          ) : (
            <EmptyState icon="user" title={tr('Accounts are off on this server', 'इस सर्वर पर खाते बंद हैं')}>
              {tr('Scans are saved in this browser only.', 'स्कैन सिर्फ़ इसी ब्राउज़र में सेव होते हैं।')}
            </EmptyState>
          )}
        </div>
      </>
    )
  }

  return (
    <>
      <PageHeader title={tr('Account', 'खाता')} description={tr('Profile, plan and API keys.', 'प्रोफ़ाइल, प्लान और API कुंजियाँ।')} />
      <div className="stack acct-page">
        <div className="acct-grid">
          <Profile user={user} />
          <PlanPanel plan={plan} usage={usage} />
        </div>
        <Keys plan={plan} />
        <SignOutPanel />
        <DangerZone login={user.login} />
      </div>
    </>
  )
}

function Profile({ user }: { user: User }) {
  const { tr } = useLang()
  return (
    <section className="panel" aria-labelledby="acct-profile-h">
      <div className="panel__head">
        <h2 id="acct-profile-h">{tr('Profile', 'प्रोफ़ाइल')}</h2>
      </div>
      <div className="panel__body acct-profile">
        <div className="acct-who">
          <Avatar login={user.login} size={40} />
          <div className="acct-who__txt">
            <strong className="truncate">{user.login}</strong>
            {user.name && <span className="subtle truncate">{user.name}</span>}
          </div>
        </div>
        <dl className="acct-kv">
          <div>
            <dt>{tr('Email', 'ईमेल')}</dt>
            <dd className="truncate">{user.email ?? tr('Not shared', 'साझा नहीं')}</dd>
          </div>
          <div>
            <dt>{tr('Signed in with', 'साइन इन')}</dt>
            <dd>
              <Icon name="github" size={14} /> GitHub
            </dd>
          </div>
          <div>
            <dt>{tr('Member since', 'सदस्य कब से')}</dt>
            <dd className="num">{day(user.createdAt)}</dd>
          </div>
        </dl>
      </div>
    </section>
  )
}

function PlanPanel({ plan, usage }: { plan: Plan | null; usage: Usage | null }) {
  const { tr } = useLang()
  const limit = usage?.limit ?? plan?.monthlyScans ?? 0
  const used = usage?.scans ?? 0
  const pct = limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0
  const full = limit > 0 && used >= limit
  return (
    <section className="panel" aria-labelledby="acct-plan-h">
      <div className="panel__head">
        <h2 id="acct-plan-h">{tr('Plan and usage', 'प्लान और इस्तेमाल')}</h2>
        {plan && <span className="badge badge--accent">{plan.name}</span>}
      </div>
      <div className="panel__body acct-plan">
        {limit > 0 ? (
          <div className="acct-usage">
            <p className="acct-usage__n">
              <span className="num">{used}</span>
              <span className="subtle"> {tr(`of ${limit} scans this month`, `/ ${limit} स्कैन इस महीने`)}</span>
            </p>
            <div
              className={`acct-meter${full ? ' acct-meter--full' : ''}`}
              role="meter"
              aria-valuemin={0}
              aria-valuemax={limit}
              aria-valuenow={Math.min(used, limit)}
              aria-label={tr('Scans used this month', 'इस महीने के स्कैन')}
            >
              <span style={{ width: `${pct}%` }} />
            </div>
            {usage?.resetsAt && <p className="subtle acct-fine">{tr(`Resets ${day(usage.resetsAt, IST)}.`, `${day(usage.resetsAt, IST)} को रीसेट।`)}</p>}
          </div>
        ) : (
          <p className="muted">{tr('No scan quota on this plan.', 'इस प्लान में स्कैन कोटा नहीं।')}</p>
        )}
        {plan && (
          <dl className="acct-kv">
            <div>
              <dt>{tr('AI code check', 'AI कोड जाँच')}</dt>
              <dd>{plan.aiEnabled ? tr('Included', 'शामिल') : tr('Not included', 'शामिल नहीं')}</dd>
            </div>
            <div>
              <dt>{tr('Scans at once', 'एक साथ स्कैन')}</dt>
              <dd className="num">{plan.maxConcurrent}</dd>
            </div>
            <div>
              <dt>{tr('API keys', 'API कुंजियाँ')}</dt>
              <dd className="num">{tr(`Up to ${plan.maxApiKeys}`, `अधिकतम ${plan.maxApiKeys}`)}</dd>
            </div>
          </dl>
        )}
      </div>
    </section>
  )
}

function Keys({ plan }: { plan: Plan | null }) {
  const { tr } = useLang()
  const [keys, setKeys] = useState<ApiKey[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)
  const [created, setCreated] = useState<{ key: ApiKey; secret: string } | null>(null)
  const [confirm, setConfirm] = useState<string | null>(null)
  const [revoking, setRevoking] = useState<string | null>(null)
  const [revokeError, setRevokeError] = useState<string | null>(null)
  const heading = useRef<HTMLHeadingElement>(null)
  const secretBox = useRef<HTMLDivElement>(null)

  function load() {
    setLoadError(null)
    listKeys()
      .then(setKeys)
      .catch((e) => setLoadError(message(e, tr('Could not load your keys.', 'कुंजियाँ लोड नहीं हुईं।'))))
  }
  useEffect(load, []) // eslint-disable-line react-hooks/exhaustive-deps

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

  useEffect(() => {
    if (created) secretBox.current?.focus()
  }, [created])

  const atLimit = !!plan && !!keys && plan.maxApiKeys > 0 && keys.length >= plan.maxApiKeys

  async function onCreate(e: FormEvent) {
    e.preventDefault()
    const n = name.trim()
    if (!n || creating) return
    setCreating(true)
    setCreateError(null)
    try {
      const r = await createKey(n)
      setCreated(r)
      setName('')
      setKeys((k) => [r.key, ...(k ?? []).filter((x) => x.id !== r.key.id)])
    } catch (err) {
      setCreateError(message(err, tr('Could not create the key.', 'कुंजी नहीं बनी।')))
    } finally {
      setCreating(false)
    }
  }

  async function onRevoke(id: string) {
    setRevoking(id)
    setRevokeError(null)
    try {
      await revokeKey(id)
      setKeys((k) => (k ?? []).filter((x) => x.id !== id))
      if (created?.key.id === id) setCreated(null)
      heading.current?.focus()
    } catch (err) {
      // Already revoked elsewhere: drop it from the list.
      if (err instanceof ApiError && err.status === 404) setKeys((k) => (k ?? []).filter((x) => x.id !== id))
      else setRevokeError(message(err, tr('Could not revoke the key.', 'कुंजी रद्द नहीं हुई।')))
    } finally {
      setRevoking(null)
      setConfirm(null)
    }
  }

  return (
    <section className="panel" aria-labelledby="acct-keys-h">
      <div className="panel__head">
        <h2 id="acct-keys-h" ref={heading} tabIndex={-1}>
          {tr('API keys', 'API कुंजियाँ')}
          {keys && keys.length > 0 && <span className="subtle num acct-count"> {keys.length}</span>}
        </h2>
      </div>
      <p className="acct-note subtle">
        {tr('For CI and scripts: send as', 'CI और स्क्रिप्ट के लिए:')} <code>Authorization: Bearer</code> {tr('to', '')} <code>/v1/scan</code>.
      </p>
      <div className="panel__body stack">
        <form className="acct-create" onSubmit={onCreate}>
          <div className="field">
            <label htmlFor="acct-key-name">{tr('Key name', 'कुंजी का नाम')}</label>
            <input
              id="acct-key-name"
              className="input"
              value={name}
              maxLength={100}
              placeholder={tr('e.g. GitHub Actions', 'जैसे GitHub Actions')}
              autoComplete="off"
              onChange={(e) => setName(e.target.value)}
              disabled={creating || atLimit}
            />
          </div>
          <button type="submit" className="btn btn--primary" disabled={!name.trim() || creating || atLimit}>
            {creating ? <span className="spinner" aria-hidden="true" /> : <Icon name="plus" size={14} />}
            {tr('Create key', 'कुंजी बनाएँ')}
          </button>
        </form>
        {atLimit && (
          <p className="subtle acct-fine">{tr(`Your plan allows ${plan!.maxApiKeys} keys. Revoke one to create another.`, `आपके प्लान में ${plan!.maxApiKeys} कुंजियाँ। नई के लिए एक रद्द करें।`)}</p>
        )}
        {createError && (
          <Callout tone="danger" role="alert">
            {createError}
          </Callout>
        )}

        {created && (
          <div className="acct-secret" ref={secretBox} tabIndex={-1} aria-labelledby="acct-secret-h">
            <p id="acct-secret-h" className="acct-secret__head">
              <Icon name="key" size={14} />
              <strong>{tr(`New key: ${created.key.name}`, `नई कुंजी: ${created.key.name}`)}</strong>
            </p>
            <CommandBlock command={created.secret} prompt={false} />
            <p className="acct-secret__warn" role="status">
              <Icon name="alert" size={14} />
              {tr('Copy it now; you will not see it again.', 'अभी कॉपी करें; यह दोबारा नहीं दिखेगी।')}
            </p>
            <div>
              <button type="button" className="btn btn--sm" onClick={() => setCreated(null)}>
                <Icon name="check" size={14} />
                {tr('Done', 'हो गया')}
              </button>
            </div>
          </div>
        )}

        {revokeError && (
          <Callout tone="danger" role="alert">
            {revokeError}
          </Callout>
        )}
        <span className="sr-only" role="status" aria-live="polite">
          {confirm ? tr('Press confirm to revoke, or Escape to cancel.', 'रद्द करने के लिए पुष्टि दबाएँ, या Escape।') : ''}
        </span>

        {loadError ? (
          <Callout tone="danger" role="alert">
            {loadError}{' '}
            <button type="button" className="link-btn" onClick={load}>
              {tr('Try again', 'फिर कोशिश करें')}
            </button>
          </Callout>
        ) : keys === null ? (
          <p className="acct-loading-row subtle" role="status">
            <span className="spinner" aria-hidden="true" />
            {tr('Loading keys…', 'कुंजियाँ लोड हो रही हैं…')}
          </p>
        ) : keys.length === 0 ? (
          <p className="muted acct-empty">{tr('No API keys yet.', 'अभी कोई API कुंजी नहीं।')}</p>
        ) : (
          <ul className="acct-keys" aria-label={tr('Your API keys', 'आपकी API कुंजियाँ')}>
            {keys.map((k) => (
              <li key={k.id} className="acct-key">
                <div className="acct-key__main">
                  <strong className="truncate">{k.name}</strong>
                  <code className="acct-key__id">vk_…{k.last4}</code>
                </div>
                <dl className="acct-key__meta">
                  <div>
                    <dt>{tr('Created', 'बनी')}</dt>
                    <dd className="num">{day(k.createdAt)}</dd>
                  </div>
                  <div>
                    <dt>{tr('Last used', 'आख़िरी इस्तेमाल')}</dt>
                    <dd className="num">{day(k.lastUsedAt) ?? tr('Never', 'कभी नहीं')}</dd>
                  </div>
                </dl>
                <div className="acct-key__actions">
                  <button
                    type="button"
                    className={`btn btn--sm ${confirm === k.id ? 'btn--danger' : 'btn--ghost'}`}
                    disabled={revoking === k.id}
                    onClick={() => (confirm === k.id ? void onRevoke(k.id) : setConfirm(k.id))}
                  >
                    <Icon name="trash" size={14} />
                    {confirm === k.id ? tr('Confirm revoke', 'रद्द करें') : tr('Revoke', 'रद्द')}
                    <span className="sr-only"> {k.name}</span>
                  </button>
                  {confirm === k.id && (
                    <button type="button" className="btn btn--sm btn--ghost" onClick={() => setConfirm(null)}>
                      {tr('Cancel', 'वापस')}
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  )
}

function SignOutPanel() {
  const { tr } = useLang()
  const { signOut, signOutAll } = useAuth()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function onAll() {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      await signOutAll()
    } catch (err) {
      setError(message(err, tr('Could not sign out of all devices.', 'सभी डिवाइस से साइन आउट नहीं हुआ।')))
      setBusy(false)
    }
  }

  return (
    <section className="panel" aria-labelledby="acct-signout-h">
      <div className="panel__head">
        <h2 id="acct-signout-h">{tr('Sign out', 'साइन आउट')}</h2>
      </div>
      <div className="panel__body stack">
        <p className="muted">{tr('Signing out of all devices ends every session of this account, here included.', 'सभी डिवाइस से साइन आउट करने पर इस खाते के सारे सेशन बंद हो जाते हैं, यहाँ वाला भी।')}</p>
        <div className="acct-create">
          <button type="button" className="btn" disabled={busy} onClick={() => void signOut()}>
            <Icon name="logout" size={14} />
            {tr('Sign out', 'साइन आउट')}
          </button>
          <button type="button" className="btn" disabled={busy} onClick={() => void onAll()}>
            {busy ? <span className="spinner" aria-hidden="true" /> : <Icon name="logout" size={14} />}
            {tr('Sign out of all devices', 'सभी डिवाइस से साइन आउट')}
          </button>
        </div>
        {error && (
          <Callout tone="danger" role="alert">
            {error}
          </Callout>
        )}
      </div>
    </section>
  )
}

function DangerZone({ login }: { login: string }) {
  const { tr } = useLang()
  const { signOut } = useAuth()
  const [typed, setTyped] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const match = typed.trim() === login

  async function onDelete(e: FormEvent) {
    e.preventDefault()
    if (!match || busy) return
    setBusy(true)
    setError(null)
    try {
      await deleteAccount(login)
      await signOut()
    } catch (err) {
      setError(message(err, tr('Could not delete the account.', 'खाता नहीं हटा।')))
      setBusy(false)
    }
  }

  return (
    <section className="panel acct-danger" aria-labelledby="acct-danger-h">
      <div className="panel__head">
        <h2 id="acct-danger-h">{tr('Delete account', 'खाता हटाएँ')}</h2>
      </div>
      <form className="panel__body stack" onSubmit={onDelete}>
        <p className="muted">
          {tr('Deletes your account, saved scans and API keys. This cannot be undone.', 'आपका खाता, सेव स्कैन और API कुंजियाँ हट जाएँगी। यह वापस नहीं होगा।')}
        </p>
        <div className="acct-create">
          <div className="field">
            <label htmlFor="acct-del">
              {tr('Type', 'पुष्टि के लिए')} <code>{login}</code> {tr('to confirm', 'लिखें')}
            </label>
            <input
              id="acct-del"
              className="input"
              value={typed}
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              onChange={(e) => setTyped(e.target.value)}
              disabled={busy}
            />
          </div>
          <button type="submit" className="btn btn--danger" disabled={!match || busy}>
            {busy ? <span className="spinner" aria-hidden="true" /> : <Icon name="trash" size={14} />}
            {tr('Delete account', 'खाता हटाएँ')}
          </button>
        </div>
        {error && (
          <Callout tone="danger" role="alert">
            {error}
          </Callout>
        )}
      </form>
    </section>
  )
}
