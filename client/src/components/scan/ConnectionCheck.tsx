import { useEffect, useState } from 'react'
import { fetchDoctor, type Probe } from '../../api'
import { useLang } from '../../lib/i18n'
import { Icon } from '../ui/Icon'

/** Tests every service a scan needs from the server, and says what to do about any that are blocked. */
export function ConnectionCheck({ auto = false }: { auto?: boolean }) {
  const { tr } = useLang()
  const [state, setState] = useState<'idle' | 'checking' | 'done' | 'error' | 'restricted'>('idle')
  const [probes, setProbes] = useState<Probe[]>([])

  async function run() {
    setState('checking')
    try {
      const doc = await fetchDoctor()
      setProbes(doc.probes)
      setState(doc.restricted ? 'restricted' : 'done')
    } catch {
      setState('error')
    }
  }

  useEffect(() => {
    if (auto) void run()
  }, [auto])

  const bad = probes.filter((p) => !p.ok)
  const advice = [...new Set(bad.map((p) => p.advice).filter(Boolean))] as string[]

  return (
    <div className="conn">
      <div className="conn__head">
        <strong>{tr('Connection check', 'कनेक्शन जाँच')}</strong>
        <button type="button" className="btn btn--sm" onClick={run} disabled={state === 'checking'}>
          {state === 'checking' ? <span className="spinner" aria-hidden="true" /> : <Icon name="refresh" size={13} />}
          {state === 'idle' ? tr('Check connection', 'कनेक्शन जाँचें') : tr('Check again', 'फिर जाँचें')}
        </button>
      </div>
      {state === 'error' && <p className="conn__note">{tr('The server did not answer the check.', 'सर्वर ने जाँच का जवाब नहीं दिया।')}</p>}
      {state === 'restricted' && (
        <p className="conn__note">{tr('Connection details are available to the server operator.', 'कनेक्शन की जानकारी सर्वर संचालक को उपलब्ध है।')}</p>
      )}
      {probes.length > 0 && (
        <ul className="conn__list" aria-live="polite">
          {probes.map((p) => (
            <li key={p.id} className={p.ok ? 'is-ok' : 'is-bad'}>
              <Icon name={p.ok ? 'check' : 'x'} size={13} />
              <span className="conn__name">{p.name}</span>
              <span className="conn__detail">{p.ok ? `${p.ms} ms` : p.detail}</span>
              {!p.ok && <span className="conn__needed">{tr(`Needed for ${p.needed}`, `ज़रूरी: ${p.needed}`)}</span>}
            </li>
          ))}
        </ul>
      )}
      {state === 'done' && (
        <p className="conn__note">
          {bad.length === 0
            ? tr('Everything a scan needs is reachable. Try the scan again.', 'स्कैन के लिए सब कुछ पहुँच में है। स्कैन फिर से चलाएँ।')
            : advice.map((a) => (
                <span key={a} className="conn__advice">
                  {a}
                </span>
              ))}
        </p>
      )}
    </div>
  )
}
