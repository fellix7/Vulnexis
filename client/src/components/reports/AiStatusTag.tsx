import type { ScanResult } from '../../types'
import { aiCounts } from '../../lib/selectors'
import { Icon } from '../ui/Icon'

/** Whether the Gemini code check ran for a scan, and for how many findings. AI provenance stays violet and dashed. */
export function AiStatusTag(props: { result: ScanResult } | { aiStatus: ScanResult['aiStatus']; assessed?: number }) {
  const status = 'result' in props ? props.result.aiStatus : props.aiStatus
  if (status === 'ok') {
    const assessed = 'result' in props ? props.result.findings.length - aiCounts(props.result.findings).NOT_ASSESSED : props.assessed
    return (
      <span className="badge badge--ai" title="The AI code check ran. Findings it did not review are shown as Not assessed.">
        <Icon name="sparkle" size={12} />
        {assessed === undefined ? 'Ran' : <>Ran · {assessed} assessed</>}
      </span>
    )
  }
  if (status === 'error')
    return (
      <span className="badge badge--warn" title="The AI code check failed for this scan. Findings are not assessed.">
        <Icon name="alert" size={12} />
        Failed
      </span>
    )
  return (
    <span className="badge" title="No source files were provided or no Gemini key was configured, so the AI code check did not run.">
      Not run
    </span>
  )
}
