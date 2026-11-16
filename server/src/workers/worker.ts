import { parentPort } from 'node:worker_threads';
import { buildContext } from '../pipeline/context.js';
import { parseLockfile } from '../pipeline/parse.js';
import type { ArchitectureContext, ExposureVerdict, Package, SourceFile } from '../types.js';

// Worker thread entry: runs the CPU-heavy synchronous analysis off the main event loop.
// Messages in and out are plain structured-clone data (no functions).

export interface ContextJobInput {
  lockfile: unknown;
  sources: SourceFile[];
  contextFiles: SourceFile[];
  base?: string;
  truncated?: boolean;
  trustDeclarations?: boolean;
}
export type JobRequest =
  | { id: number; kind: 'parse'; lockfile: unknown }
  | { id: number; kind: 'context'; input: ContextJobInput; packages?: Package[] };
export interface ContextJobResult {
  context: ArchitectureContext;
  /** exposureOf(pkg) for every non-dev package, keyed `${name}@${version}` (null = the function returned undefined) */
  exposures: Record<string, ExposureVerdict | null>;
}
export type JobResponse = { id: number; ok: true; result: Package[] | ContextJobResult | null } | { id: number; ok: false; message: string };

export function runJob(req: JobRequest): Package[] | ContextJobResult | null {
  if (req.kind === 'parse') return parseLockfile(req.lockfile);
  const built = buildContext(req.input);
  if (!built) return null;
  const exposures: Record<string, ExposureVerdict | null> = Object.create(null);
  for (const pkg of req.packages ?? parseLockfile(req.input.lockfile)) {
    if (pkg.dev) continue;
    exposures[`${pkg.name}@${pkg.version}`] = built.exposureOf(pkg) ?? null;
  }
  return { context: built.context, exposures };
}

if (parentPort) {
  const port = parentPort;
  port.on('message', (req: JobRequest) => {
    let res: JobResponse;
    try {
      res = { id: req.id, ok: true, result: runJob(req) };
    } catch (e) {
      res = { id: req.id, ok: false, message: e instanceof Error ? e.message : String(e) };
    }
    port.postMessage(res);
  });
}
