export interface BackoffOptions {
  baseMs?: number;
  maxMs?: number;
  factor?: number;
  jitter?: number;
}

/** Exponential backoff delay with full jitter. attempt starts at 0. */
export function backoffDelay(attempt: number, opts: BackoffOptions = {}): number {
  const { baseMs = 250, maxMs = 10_000, factor = 2, jitter = 0.3 } = opts;
  const raw = Math.min(maxMs, baseMs * factor ** attempt);
  const delta = raw * jitter;
  return Math.max(0, Math.round(raw - delta + Math.random() * 2 * delta));
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Runs tasks strictly one after another, in submission order. Used per language
 * channel so captions/audio for segment N are delivered before segment N+1 even
 * when translations complete out of order.
 */
export class SerialQueue {
  private tail: Promise<void> = Promise.resolve();
  private pending = 0;

  get size(): number {
    return this.pending;
  }

  push(task: () => Promise<void>): Promise<void> {
    this.pending++;
    const run = this.tail.then(task).finally(() => {
      this.pending--;
    });
    this.tail = run.catch(() => undefined);
    return run;
  }
}
