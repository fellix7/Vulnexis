// A fair in-process FIFO queue in front of the scan slots.
// shortcut: per-process state; behind several instances, put a shared queue or sticky routing in front.

export class QueueFullError extends Error {}
export class ClientLimitError extends Error {}

export interface QueueOptions {
  /** scans running at once */
  maxRunning: number;
  /** scans waiting for a slot */
  maxQueued: number;
  /** running + queued per client key */
  perClient: number;
}

export interface Ticket {
  /** 0 = a slot was free and is already taken; otherwise 1 = next in line */
  position: number;
  /** Resolves with a release function once a slot is held. Rejects if the signal aborts while waiting. Always call release (idempotent). */
  slot: Promise<() => void>;
}

interface Waiter {
  client: string;
  grant: (release: () => void) => void;
  fail: (e: unknown) => void;
  onPosition?: (position: number, ahead: number) => void;
  signal?: AbortSignal;
  onAbort: () => void;
  last: number;
}

export class ScanQueue {
  private running = 0;
  private readonly waiting: Waiter[] = [];
  private readonly perClient = new Map<string, number>();

  constructor(private readonly opts: QueueOptions) {}

  get stats() {
    return { running: this.running, queued: this.waiting.length };
  }

  private dec(client: string) {
    const n = (this.perClient.get(client) ?? 1) - 1;
    if (n <= 0) this.perClient.delete(client);
    else this.perClient.set(client, n);
  }

  private releaser(client: string): () => void {
    let done = false;
    return () => {
      if (done) return;
      done = true;
      this.running--;
      this.dec(client);
      this.pump();
    };
  }

  /** `cap` overrides the per-client limit for this call (the plan's max_concurrent). Throws ClientLimitError / QueueFullError synchronously when the request cannot be accepted. */
  join(client: string, signal?: AbortSignal, onPosition?: (position: number, ahead: number) => void, cap?: number): Ticket {
    if ((this.perClient.get(client) ?? 0) >= (cap ?? this.opts.perClient)) throw new ClientLimitError();
    if (this.running < this.opts.maxRunning && this.waiting.length === 0) {
      this.running++;
      this.perClient.set(client, (this.perClient.get(client) ?? 0) + 1);
      return { position: 0, slot: Promise.resolve(this.releaser(client)) };
    }
    if (this.waiting.length >= this.opts.maxQueued) throw new QueueFullError();
    this.perClient.set(client, (this.perClient.get(client) ?? 0) + 1);
    const slot = new Promise<() => void>((grant, fail) => {
      const w: Waiter = { client, grant, fail, onPosition, signal, last: this.waiting.length + 1, onAbort: () => {} };
      w.onAbort = () => {
        const i = this.waiting.indexOf(w);
        if (i < 0) return;
        this.waiting.splice(i, 1);
        this.dec(client);
        fail(signal?.reason ?? new Error('aborted'));
        this.notify();
      };
      if (signal?.aborted) {
        this.dec(client);
        return fail(signal.reason ?? new Error('aborted'));
      }
      signal?.addEventListener('abort', w.onAbort, { once: true });
      this.waiting.push(w);
    });
    slot.catch(() => {}); // callers handle it; avoid an unhandled rejection if they never await
    return { position: this.waiting.length, slot };
  }

  private pump() {
    while (this.running < this.opts.maxRunning && this.waiting.length) {
      const w = this.waiting.shift()!;
      w.signal?.removeEventListener('abort', w.onAbort);
      this.running++;
      w.grant(this.releaser(w.client)); // per-client count carries over from the waiting state
    }
    this.notify();
  }

  private notify() {
    this.waiting.forEach((w, i) => {
      const pos = i + 1;
      if (pos !== w.last) {
        w.last = pos;
        try {
          w.onPosition?.(pos, i);
        } catch {
          /* a broken listener must not stall the queue */
        }
      }
    });
  }
}
