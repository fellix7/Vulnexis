import type { RepoRef } from '../../types'
import { Icon } from './Icon'

const n = (v: number) => v.toLocaleString('en-IN')

/** Stars and contributors of a scanned GitHub repository. Shown only for scans by GitHub link, and only when GitHub answered. */
export function RepoStats({ repo }: { repo: RepoRef }) {
  if (repo.stars === undefined && repo.contributors === undefined) return null
  return (
    <span className="repo-stats">
      {repo.stars !== undefined && (
        <a className="repo-stat" href={`${repo.url.replace(/\/tree\/.*$/, '')}/stargazers`} target="_blank" rel="noreferrer noopener">
          <Icon name="star" size={12} />
          <span className="num">{n(repo.stars)}</span> {repo.stars === 1 ? 'star' : 'stars'}
        </a>
      )}
      {repo.contributors !== undefined && (
        <a className="repo-stat" href={`${repo.url.replace(/\/tree\/.*$/, '')}/graphs/contributors`} target="_blank" rel="noreferrer noopener">
          <Icon name="users" size={12} />
          <span className="num">{repo.contributors >= 500 ? '500+' : n(repo.contributors)}</span> {repo.contributors === 1 ? 'contributor' : 'contributors'}
        </a>
      )}
    </span>
  )
}
