import os from 'node:os';
import { Worker } from 'node:worker_threads';
import { buildContext } from '../pipeline/context.js';
import { currentSignal } from '../scanStats.js';
import type { ExposureVerdict, Package } from '../types.js';
import type { ContextJobInput, ContextJobResult, JobRequest, JobResponse } from './worker.js';

// A small pool of worker threads for lockfile parsing and architecture analysis, so a 6,000-package monorepo
// cannot freeze every other user's scan. parseLockfileAsync / buildContextAsync are drop-in async versions of
// parseLockfile / buildContext with identical results.
//
//   WORKER_POOL_SIZE     threads (default availableParallelism() - 1, at least 1, at most 4)
//   ANALYSIS_TIMEOUT_MS  per job, from the moment a worker starts it (default 60000)
//   WORKER_MAX_MB        old-generation heap limit per worker (default 512)

export const TOO_LARGE_MESSAGE = 'This project is too large to analyse right now.';

const envInt = (name: string, dflt: number) => {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : dflt;
};
const poolSize = () => Math.min(4, envInt('WORKER_POOL_SIZE', Math.max(1, os.availableParallelism() - 1)));

// From dist/*.js the sibling worker.js is used; under tsx (src/*.ts) worker.ts is started with tsx loaded.
const isTs = import.meta.url.endsWith('.ts');
const workerUrl = new URL(isTs ? './worker.ts' : './worker.js', import.meta.url);
const execArgv = isTs ? ['--import', import.meta.resolve('tsx')] : [];

interface Job {
  req: JobRequest;
  resolve(v: unknown): void;
  reject(e: Error): void;
  signal?: AbortSignal;
  onAbort?: () => void;
  timer?: NodeJS.Timeout;
}
interface Slot {
  worker: Worker;
  job: Job | null;
}

const slots: Slot[] = [];
const queue: Job[] = [];
let nextId = 1;
let closed = false;

function spawn(): Slot {
  const worker = new Worker(workerUrl, {
    execArgv,
    resourceLimits: { maxOldGenerationSizeMb: envInt('WORKER_MAX_MB', 512) },
  });
  worker.unref(); // an idle pool never keeps the process alive
  const slot: Slot = { worker, job: null };
  worker.on('message', (res: JobResponse) => {
    const job = slot.job;
    if (!job || res.id !== job.req.id) return;
    finish(slot);
    if (res.ok) job.resolve(res.result);
    else job.reject(new Error(res.message)); // user-facing messages from parseLockfile pass through unchanged
    pump();
  });
  const died = (err?: Error) => {
    const i = slots.indexOf(slot);
    if (i >= 0) slots.splice(i, 1); // replaced on demand by the next pump()
    const job = slot.job;
    if (job) {
      finish(slot);
      console.warn(`[workers] analysis worker stopped${err ? `: ${err.message}` : ''}`);
      job.reject(new Error(TOO_LARGE_MESSAGE, { cause: err }));
    }
    pump();
  };
  worker.on('error', died);
  worker.on('exit', () => died());
  slots.push(slot);
  return slot;
}

/** Detach the running job from its slot (timer, abort listener). */
function finish(slot: Slot) {
  const job = slot.job;
  slot.job = null;
  if (!job) return;
  if (job.timer) clearTimeout(job.timer);
  if (job.signal && job.onAbort) job.signal.removeEventListener('abort', job.onAbort);
}

/** Kill a worker whose job must stop (timeout / cancel). The slot is dropped; pump() starts a fresh worker when needed. */
function kill(slot: Slot) {
  const i = slots.indexOf(slot);
  if (i >= 0) slots.splice(i, 1);
  slot.job = null;
  void slot.worker.terminate();
}

function pump() {
  while (queue.length) {
    let slot = slots.find((s) => !s.job);
    if (!slot && slots.length < poolSize()) slot = spawn();
    if (!slot) return;
    const job = queue.shift()!;
    slot.job = job;
    const s = slot;
    job.timer = setTimeout(() => {
      kill(s);
      job.signal?.removeEventListener('abort', job.onAbort!);
      job.reject(new Error(TOO_LARGE_MESSAGE));
      pump();
    }, envInt('ANALYSIS_TIMEOUT_MS', 60_000));
    job.timer.unref();
    try {
      s.worker.postMessage(job.req);
    } catch (e) {
      // not cloneable: surface the real problem
      finish(s);
      job.reject(e instanceof Error ? e : new Error(String(e)));
    }
  }
}

function run<T>(make: (id: number) => JobRequest): Promise<T> {
  if (closed) return Promise.reject(new Error('The analysis workers have been shut down.'));
  const signal = currentSignal();
  if (signal?.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const job: Job = { req: make(nextId++), resolve: resolve as (v: unknown) => void, reject, signal };
    if (signal) {
      job.onAbort = () => {
        const qi = queue.indexOf(job);
        if (qi >= 0) queue.splice(qi, 1);
        else {
          const slot = slots.find((s) => s.job === job);
          if (slot) {
            if (job.timer) clearTimeout(job.timer);
            kill(slot);
          }
        }
        reject(signal.reason);
        pump();
      };
      signal.addEventListener('abort', job.onAbort, { once: true });
    }
    queue.push(job);
    pump();
  });
}

/** Same result as parseLockfile(lock), computed on a worker thread. */
export function parseLockfileAsync(lock: unknown): Promise<Package[]> {
  return run<Package[]>((id) => ({ id, kind: 'parse', lockfile: lock }));
}

type Built = ReturnType<typeof buildContext>;

/**
 * Same result as buildContext(input), computed on a worker thread. exposureOf cannot cross threads, so the worker
 * evaluates it for every non-dev package and the returned function is a lookup into that table.
 * Pass `packages` (the result of parseLockfile for this lockfile) to save the worker from parsing it again.
 */
export async function buildContextAsync(input: ContextJobInput, packages?: Package[]): Promise<Built> {
  const out = await run<ContextJobResult | null>((id) => ({ id, kind: 'context', input, ...(packages ? { packages } : {}) }));
  if (!out) return null;
  const table = new Map<string, ExposureVerdict | null>(Object.entries(out.exposures));
  return { context: out.context, exposureOf: (pkg) => table.get(`${pkg.name}@${pkg.version}`) ?? undefined };
}

/** Stop every worker (call on SIGTERM / SIGINT before exit). Pending jobs fail. */
export async function shutdownWorkers(): Promise<void> {
  closed = true;
  for (const j of queue.splice(0)) j.reject(new Error('The analysis workers have been shut down.'));
  await Promise.all(slots.splice(0).map((s) => {
    const job = s.job;
    finish(s);
    job?.reject(new Error('The analysis workers have been shut down.'));
    return s.worker.terminate();
  }));
}

/** For checks: lets the pool be used again after shutdownWorkers(). */
export const resetWorkers = () => {
  closed = false;
};
