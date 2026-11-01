/**
 * A listing from the workspace (its tools, or its prompts) as the local MCP
 * server serves it: the last good one is kept and answered at once, with a
 * fresh one asked for behind it. Before there is one, a list waits until a
 * deadline at most (one wait shared from boot); one that lands after an
 * answer went out is announced (`list_changed`), so the client asks again
 * and gets it from what was kept.
 */

/** `p`, or `fallback` once `ms` have passed (or when `p` fails). */
export function within<T>(p: Promise<T>, ms: number, fallback: T): Promise<{ value: T; late: boolean }> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ value: fallback, late: true }), Math.max(0, ms));
    timer.unref();
    p.then(
      (value) => {
        clearTimeout(timer);
        resolve({ value, late: false });
      },
      () => {
        clearTimeout(timer);
        resolve({ value: fallback, late: false });
      },
    );
  });
}

export class KeptListing<T> {
  private kept: T[] | null = null;
  private asking: Promise<T[] | null> | null = null;
  /** Whether the client has had an answer, so a change is worth announcing. */
  private answered = false;

  constructor(
    private readonly fetchList: () => Promise<T[] | null>,
    private readonly onChange: () => void,
  ) {}

  /** Ask the workspace again (one request at a time); keep and announce what's new. */
  refresh(): Promise<T[] | null> {
    this.asking ??= this.fetchList().then(
      (v) => {
        this.asking = null;
        if (v) {
          const changed = JSON.stringify(v) !== JSON.stringify(this.kept);
          this.kept = v;
          if (changed && this.answered) this.onChange();
        }
        return v;
      },
      () => {
        this.asking = null;
        return null;
      },
    );
    return this.asking;
  }

  /** What to answer now: the kept listing at once (refreshed behind it), else what arrives by `deadline`. */
  async get(deadline: number): Promise<T[]> {
    if (this.kept) {
      void this.refresh();
      this.answered = true;
      return this.kept;
    }
    const { value } = await within(this.refresh(), deadline - Date.now(), null);
    this.answered = true;
    return value ?? this.kept ?? [];
  }
}
