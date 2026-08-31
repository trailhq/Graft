/**
 * The work queue.
 *
 * A webhook must be answered in seconds, and a review takes tens of them, so the
 * HTTP handler's only job is to enqueue. Two properties matter and neither comes
 * free from a bare array:
 *
 *  - **Superseding.** Five pushes to one pull request in a minute is normal, and
 *    reviewing the first four is wasted work whose comments are immediately
 *    overwritten. A queued job for the same PR is replaced, not appended.
 *  - **A ceiling.** One repository must not be able to starve every other
 *    installation, so a fixed number of workers drain the queue.
 */

export interface QueueOptions {
  concurrency?: number;
  /** Called for every failure: a job that throws must not take the process down,
   * and a silent catch would hide a broken installation forever. */
  onError?: (err: unknown, key: string) => void;
}

export class WorkQueue<T> {
  private readonly pending = new Map<string, T>();
  private readonly running = new Set<string>();
  private readonly concurrency: number;
  private readonly onError: (err: unknown, key: string) => void;
  private idle: Array<() => void> = [];

  constructor(
    private readonly run: (item: T) => Promise<void>,
    opts: QueueOptions = {},
  ) {
    this.concurrency = Math.max(1, opts.concurrency ?? 2);
    this.onError = opts.onError ?? (() => {});
  }

  /**
   * Queue work under `key`, replacing anything queued under it and not yet started.
   *
   * A job already RUNNING is left alone: cancelling mid-clone buys nothing, and
   * the newer job simply runs after it and overwrites the comment.
   */
  push(key: string, item: T): void {
    this.pending.set(key, item);
    this.pump();
  }

  get size(): number {
    return this.pending.size + this.running.size;
  }

  /** Resolves when nothing is queued or running — for tests and for shutdown. */
  async drain(): Promise<void> {
    if (this.size === 0) return;
    await new Promise<void>((resolve) => this.idle.push(resolve));
  }

  private pump(): void {
    while (this.running.size < this.concurrency) {
      const next = this.pending.entries().next();
      if (next.done) break;
      const [key, item] = next.value;
      this.pending.delete(key);
      this.running.add(key);
      void this.run(item)
        .catch((err) => this.onError(err, key))
        .finally(() => {
          this.running.delete(key);
          this.pump();
          if (this.size === 0) {
            const waiting = this.idle;
            this.idle = [];
            for (const resolve of waiting) resolve();
          }
        });
    }
  }
}
