/**
 * Where a reviewed pull request's page lives.
 *
 * This is the part GitHub Pages could not do. A private repository's graph must
 * not be readable by anyone who guesses a URL, and the Actions route had only two
 * options: publish to a public branch, or hand the reader a zip. So the page is
 * held here and linked with a signed, expiring URL.
 *
 * The signature is the whole access-control story, deliberately: it is a
 * capability, not a login. Anyone with the link can read that one page until it
 * expires, which is the same property a GitHub artifact link has, and the link
 * only ever appears in a comment on the pull request it describes.
 *
 * Pages are mirrored to `dir`, when one is given, because the token is DERIVED
 * from the id rather than stored: a link keeps passing the signature check for as
 * long as the secret lives, so a process that lost its pages answers 404 to a
 * link that looks perfectly valid. That failure is silent at both ends — the
 * comment still sits on the pull request, the reviewer just sees "not found" —
 * and one restart of a container with nothing mounted stranded 29 of them. Disk
 * is the fix; without a directory this behaves exactly as it did before.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Long enough to review a PR at leisure, short enough that a leaked link dies. */
const DEFAULT_TTL_MS = 14 * 24 * 60 * 60 * 1000;
/** A page is ~50 kB; a few hundred of them is nothing, and eviction is by age. */
const DEFAULT_MAX_PAGES = 500;
/** One file per page, named by its id. The extension also means "fully written". */
const SUFFIX = ".json";

export interface StoredPage {
  html: string;
  storedMs: number;
}

export interface PageStoreOptions {
  secret: string;
  ttlMs?: number;
  maxPages?: number;
  now?: () => number;
  /** Kept across restarts here. Absent: pages live only as long as the process. */
  dir?: string;
}

export class PageStore {
  private readonly pages = new Map<string, StoredPage>();
  private readonly secret: string;
  private readonly ttlMs: number;
  private readonly maxPages: number;
  private readonly now: () => number;
  private readonly dir: string | undefined;

  constructor(opts: PageStoreOptions) {
    this.secret = opts.secret;
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
    this.maxPages = opts.maxPages ?? DEFAULT_MAX_PAGES;
    this.now = opts.now ?? Date.now;
    this.dir = opts.dir;
    this.hydrate();
  }

  /** `owner/repo#number` → a path segment safe to put in a URL. */
  static idFor(owner: string, repo: string, number: number): string {
    return `${owner}__${repo}__${number}`.replace(/[^A-Za-z0-9_.-]/g, "-");
  }

  /** Store (replacing any previous page for the same PR) and return `id` + `token`. */
  put(owner: string, repo: string, number: number, html: string): { id: string; token: string } {
    const id = PageStore.idFor(owner, repo, number);
    const page: StoredPage = { html, storedMs: this.now() };
    this.pages.set(id, page);
    this.write(id, page);
    this.evict();
    return { id, token: this.sign(id) };
  }

  /**
   * The page, if the token is valid and it has not expired.
   *
   * Expiry is checked against the STORED time rather than encoded in the token,
   * so a link cannot outlive the data it points at — and re-reviewing a PR
   * refreshes both together.
   *
   * Answered from memory even when there is a directory: `id` comes off a URL,
   * and an id that never reaches the filesystem cannot be walked out of it.
   */
  get(id: string, token: string | undefined): string | null {
    const page = this.pages.get(id);
    if (!page || !token || !this.valid(id, token)) return null;
    if (this.now() - page.storedMs > this.ttlMs) {
      this.remove(id);
      return null;
    }
    return page.html;
  }

  get size(): number {
    return this.pages.size;
  }

  private sign(id: string): string {
    return createHmac("sha256", this.secret).update(id).digest("hex").slice(0, 32);
  }

  private valid(id: string, token: string): boolean {
    const a = Buffer.from(this.sign(id));
    const b = Buffer.from(token);
    // Length first: timingSafeEqual throws on a mismatch, which would turn a
    // truncated token into a 500 instead of a 404.
    return a.length === b.length && timingSafeEqual(a, b);
  }

  /** Oldest out first, plus anything past its TTL. */
  private evict(): void {
    const cutoff = this.now() - this.ttlMs;
    for (const [id, page] of this.pages) if (page.storedMs < cutoff) this.remove(id);
    while (this.pages.size > this.maxPages) {
      const oldest = this.pages.keys().next();
      if (oldest.done) break;
      this.remove(oldest.value);
    }
  }

  /** Take back what a previous process left on disk. */
  private hydrate(): void {
    const dir = this.dir;
    if (!dir) return;

    let names: string[];
    try {
      mkdirSync(dir, { recursive: true });
      names = readdirSync(dir);
    } catch (err) {
      // Nothing usable there: carry on in memory, which is exactly what every
      // deployment without a directory does anyway.
      console.warn(`page store: ${dir} is unusable, pages will not survive a restart (${reason(err)})`);
      return;
    }

    const loaded: Array<[string, StoredPage]> = [];
    for (const name of names) {
      // The suffix also skips the temp files a write leaves behind when it dies
      // partway, so a half-written page is never a candidate to begin with.
      if (!name.endsWith(SUFFIX)) continue;
      const page = this.read(join(dir, name));
      if (page) loaded.push([name.slice(0, -SUFFIX.length), page]);
    }
    // Oldest first, because eviction takes the front of the Map and readdir order
    // is the filesystem's business rather than a record of what happened when.
    loaded.sort((a, b) => a[1].storedMs - b[1].storedMs);
    for (const [id, page] of loaded) this.pages.set(id, page);
    // A restart is also when pages that expired while the process was down go.
    this.evict();
  }

  /** A stored page, or nothing: truncated, corrupt and gone are one answer here. */
  private read(file: string): StoredPage | null {
    try {
      const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
      const { html, storedMs } = (parsed ?? {}) as Partial<StoredPage>;
      if (typeof html !== "string" || typeof storedMs !== "number" || !Number.isFinite(storedMs)) return null;
      return { html, storedMs };
    } catch {
      return null;
    }
  }

  /**
   * Temp file, then rename: a reader only ever sees a whole page, and two reviews
   * of the same pull request racing each other leave one of them intact rather
   * than the two interleaved.
   */
  private write(id: string, page: StoredPage): void {
    const dir = this.dir;
    if (!dir) return;

    const tmp = join(dir, `${id}.${randomBytes(6).toString("hex")}.tmp`);
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(tmp, JSON.stringify(page));
      renameSync(tmp, join(dir, `${id}${SUFFIX}`));
    } catch (err) {
      // The page is in memory and its link works; it just will not outlive this
      // process. Worth a line in the log and nothing more: throwing here would
      // fail a review that has already done all of its work.
      console.warn(`page store: could not write ${id} (${reason(err)})`);
      try {
        unlinkSync(tmp);
      } catch {
        // Never created, or already renamed into place.
      }
    }
  }

  private remove(id: string): void {
    this.pages.delete(id);
    if (!this.dir) return;
    try {
      unlinkSync(join(this.dir, `${id}${SUFFIX}`));
    } catch {
      // Already gone: deleted underneath us, or it never reached the disk.
    }
  }
}

const reason = (err: unknown): string => (err instanceof Error ? err.message : String(err));
