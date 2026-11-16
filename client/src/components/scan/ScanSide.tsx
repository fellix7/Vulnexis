import { formatBytes } from '../../lib/format'
import { MAX_BYTES, MAX_FILES } from '../../lib/sources'
import { CommandBlock } from '../ui/Kit'
import { Icon, type IconName } from '../ui/Icon'

const POINTS: { icon: IconName; title: string; body: string }[] = [
  { icon: 'eye', title: 'Read only', body: 'Never installed, built or run.' },
  { icon: 'upload', title: 'Only names and versions leave', body: 'Looked up at OSV.dev, EPSS, CISA KEV and npm.' },
  { icon: 'sparkle', title: 'Gemini sees line windows', body: 'Only short line windows around imports and uses, obvious secrets masked. Never whole files.' },
  { icon: 'database', title: 'History stays here', body: 'Saved in this browser only.' },
]

/** Side column on /scan: what happens to the user's files, and what can be scanned. */
export function ScanSide() {
  return (
    <>
      <section className="scan-aside" aria-labelledby="scan-privacy-h">
        <h2 id="scan-privacy-h">Your files</h2>
        <ul className="scan-points">
          {POINTS.map((p) => (
            <li key={p.title} className="scan-point">
              <span className="scan-point__icon" aria-hidden="true">
                <Icon name={p.icon} size={14} />
              </span>
              <div>
                <strong>{p.title}</strong>
                <p>{p.body}</p>
              </div>
            </li>
          ))}
        </ul>
      </section>

      <details className="scan-aside scan-more">
        <summary>Supported formats</summary>
        <dl className="scan-formats">
          <div>
            <dt>Lockfile</dt>
            <dd>
              <code>package-lock.json</code> or <code>npm-shrinkwrap.json</code>, lockfileVersion 2 or 3, up to 10 MB. Not <code>yarn.lock</code> or{' '}
              <code>pnpm-lock.yaml</code>.
            </dd>
          </div>
          <div>
            <dt>Source files</dt>
            <dd>
              <code>.js .jsx .ts .tsx .mjs .cjs</code>, up to {MAX_FILES} files and {formatBytes(MAX_BYTES)}.
            </dd>
          </div>
          <div>
            <dt>Architecture files</dt>
            <dd>docker-compose, Kubernetes, serverless.yml, Procfile, Dockerfile, OpenAPI, Markdown docs, vulnexis.yml.</dd>
          </div>
        </dl>
        <p className="scan-aside__sub">Old lockfile (npm 6)? Regenerate it:</p>
        <CommandBlock command="npm install --package-lock-only" />
      </details>
    </>
  )
}
