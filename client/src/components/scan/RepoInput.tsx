import { useState, type FormEvent } from 'react'
import { useLang } from '../../lib/i18n'
import { Icon } from '../ui/Icon'

// Real, public, deliberately vulnerable Node.js apps: safe targets judges can tap to test.
const EXAMPLES = [
  { url: 'https://github.com/OWASP/NodeGoat', label: 'OWASP/NodeGoat' },
  { url: 'https://github.com/snyk-labs/nodejs-goof', label: 'snyk-labs/nodejs-goof' },
]

const GH = /^(https?:\/\/)?(www\.)?github\.com\/[\w.-]+\/[\w.-]+(\/tree\/[\w./-]+)?\/?$|^[\w.-]+\/[\w.-]+$/

/** Step 0: scan a public GitHub repository by link. The easiest path on a phone (no files needed). */
export function RepoInput({ disabled, onScan, offline }: { disabled: boolean; onScan(url: string): void; offline: boolean }) {
  const { tr } = useLang()
  const [url, setUrl] = useState('')
  const [touched, setTouched] = useState(false)
  const value = url.trim()
  const valid = GH.test(value)

  function submit(e: FormEvent) {
    e.preventDefault()
    setTouched(true)
    if (valid && !disabled) onScan(/^[\w.-]+\/[\w.-]+$/.test(value) ? `https://github.com/${value}` : value)
  }

  return (
    <section className="repo-card" aria-labelledby="repo-h">
      <div className="repo-card__head">
        <span className="repo-card__icon" aria-hidden="true">
          <Icon name="github" size={18} />
        </span>
        <div>
          <h2 id="repo-h">{tr('Scan a public GitHub repository', 'पब्लिक GitHub रिपॉज़िटरी स्कैन करें')}</h2>
          <p>
            {tr(
              'Fastest way, and it works on a phone. The agent downloads the repo as text, reads package-lock.json and your JS/TS code. Nothing is installed or run.',
              'सबसे आसान तरीका, फ़ोन पर भी चलता है। एजेंट रिपॉज़िटरी को सिर्फ़ टेक्स्ट की तरह पढ़ता है: package-lock.json और आपका JS/TS कोड। कुछ भी इंस्टॉल या रन नहीं होता।',
            )}
          </p>
        </div>
      </div>
      <form className="repo-form" onSubmit={submit} noValidate>
        <label htmlFor="repo-url" className="sr-only">
          {tr('GitHub repository link', 'GitHub रिपॉज़िटरी लिंक')}
        </label>
        <input
          id="repo-url"
          className="input repo-form__input"
          type="url"
          inputMode="url"
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          placeholder="https://github.com/owner/repo"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onBlur={() => setTouched(true)}
          disabled={disabled}
          aria-invalid={touched && value !== '' && !valid}
          aria-describedby="repo-hint"
        />
        <button type="submit" className="btn btn--primary repo-form__go" disabled={disabled || !valid}>
          <Icon name="bot" size={15} />
          {tr('Run agent', 'एजेंट चलाएँ')}
        </button>
      </form>
      <p id="repo-hint" className={`repo-hint${touched && value !== '' && !valid ? ' repo-hint--bad' : ''}`}>
        {touched && value !== '' && !valid
          ? tr('Paste a link like https://github.com/owner/repo', 'ऐसा लिंक डालें: https://github.com/owner/repo')
          : offline
            ? tr('This server is offline (saved snapshots), so new repositories may be refused. The sample project always works.', 'यह सर्वर ऑफ़लाइन है, इसलिए नई रिपॉज़िटरी शायद न चलें। सैंपल प्रोजेक्ट हमेशा चलता है।')
            : tr('Needs an npm package-lock.json in the repo. Public repositories only.', 'रिपॉज़िटरी में npm package-lock.json होना चाहिए। सिर्फ़ पब्लिक रिपॉज़िटरी।')}
      </p>
      <div className="repo-examples">
        <span className="subtle">{tr('Try one:', 'आज़माएँ:')}</span>
        {EXAMPLES.map((ex) => (
          <button key={ex.url} type="button" className="chip" disabled={disabled} onClick={() => onScan(ex.url)}>
            <Icon name="github" size={12} />
            {ex.label}
          </button>
        ))}
      </div>
    </section>
  )
}
