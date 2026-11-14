import type { SourceFile } from '../types'

export const MAX_FILES = 300
export const MAX_BYTES = 3 * 1024 * 1024
const SOURCE_EXT = /\.(js|jsx|ts|tsx|mjs|cjs)$/i
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', '.git'])
const MAX_CONTEXT_FILES = 60
const MAX_CONTEXT_FILE_BYTES = 256 * 1024
const MAX_CONTEXT_BYTES = 1536 * 1024
const DOC_NAME = /(architecture|security|threat|deploy|infra|readme|design|overview|system|network|runbook|operations)/i

/** Deployment and architecture files the server reads for exposure. Mirrors isContextPath() in server/src/pipeline/context.ts. */
export function isContextPath(p: string): boolean {
  const base = p.split('/').pop() ?? p
  if (/^\.?vulnexis\.ya?ml$/i.test(base)) return true
  if (/^Dockerfile(\.[\w.-]+)?$|\.Dockerfile$/.test(base) || base === 'Procfile' || base === 'package.json') return true
  if (/\.ya?ml$/i.test(base)) return !/^(pnpm-lock|\.?eslintrc|\.?prettierrc|\.?babelrc|codecov|mkdocs|\.?gitlab-ci|dependabot|renovate)/i.test(base)
  if (/\.json$/i.test(base)) return /(openapi|swagger)/i.test(base)
  if (/\.md$/i.test(base)) return DOC_NAME.test(base) || /(^|\/)docs?\//i.test(p)
  return false
}

export interface CollectedSources {
  folderName: string
  sources: SourceFile[]
  contextFiles: SourceFile[] // docker-compose.yml, Kubernetes, OpenAPI, ARCHITECTURE.md, package.json, …
  truncated: boolean // some source files were left out by the limits
  totalBytes: number
  skipped: {
    excludedDir: number
    nonSource: number
    overFileCap: number
    overSizeCap: number
    unreadable: number
  }
}

/** Filter a folder picked via <input webkitdirectory> down to source files and read them. */
export async function collectSources(files: FileList | File[]): Promise<CollectedSources> {
  const list = Array.from(files).map((file) => ({
    file,
    rel: (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name,
  }))
  list.sort((a, b) => a.rel.localeCompare(b.rel))

  const skipped = { excludedDir: 0, nonSource: 0, overFileCap: 0, overSizeCap: 0, unreadable: 0 }
  const folderName = list[0]?.rel.includes('/') ? list[0].rel.split('/')[0] : ''
  const chosen: { file: File; path: string }[] = []
  const context: { file: File; path: string }[] = []
  let bytes = 0
  let contextBytes = 0

  for (const { file, rel } of list) {
    const parts = rel.split('/')
    const path = parts.length > 1 ? parts.slice(1).join('/') : rel // strip the top folder name
    const dirs = path.split('/').slice(0, -1)
    if (dirs.some((d) => SKIP_DIRS.has(d))) {
      skipped.excludedDir++
    } else if (!SOURCE_EXT.test(path) && isContextPath(path)) {
      if (context.length < MAX_CONTEXT_FILES && file.size <= MAX_CONTEXT_FILE_BYTES && contextBytes + file.size <= MAX_CONTEXT_BYTES) {
        contextBytes += file.size
        context.push({ file, path })
      }
    } else if (!SOURCE_EXT.test(path)) {
      skipped.nonSource++
    } else if (chosen.length >= MAX_FILES) {
      skipped.overFileCap++
    } else if (bytes + file.size > MAX_BYTES) {
      skipped.overSizeCap++
    } else {
      bytes += file.size
      chosen.push({ file, path })
    }
  }

  const slots: (SourceFile | null)[] = chosen.map(() => null)
  let totalBytes = 0
  await Promise.all(
    chosen.map(async ({ file, path }, i) => {
      try {
        slots[i] = { path, content: await file.text() }
        totalBytes += file.size
      } catch {
        skipped.unreadable++
      }
    }),
  )
  const contextFiles = (
    await Promise.all(context.map(async ({ file, path }) => ({ path, content: await file.text().catch(() => null) })))
  ).filter((c): c is SourceFile => c.content !== null)
  return {
    folderName,
    sources: slots.filter((s): s is SourceFile => s !== null),
    contextFiles,
    truncated: skipped.overFileCap + skipped.overSizeCap + skipped.unreadable > 0,
    totalBytes: totalBytes + contextBytes,
    skipped,
  }
}
