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
 */
import { createHmac, timingSafeEqual } from "node:crypto";

/** Long enough to review a PR at leisure, short enough that a leaked link dies. */
const DEFAULT_TTL_MS = 14 * 24 * 60 * 60 * 1000;
/** A page is ~50 kB; a few hundred of them is nothing, and eviction is by age. */
const DEFAULT_MAX_PAGES = 500;

export interface StoredPage {
  html: string;
  storedMs: number;
}

export interface PageStoreOptions {
  secret: string;
  ttlMs?: number;
  maxPages?: number;
  now?: () => number;
}

export class PageStore {
  private readonly pages = new Map<string, StoredPage>();
  private readonly secret: string;
  private readonly ttlMs: number;
  private readonly maxPages: number;
  private readonly now: () => number;

  constructor(opts: PageStoreOptions) {
    this.secret = opts.secret;
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
    this.maxPages = opts.maxPages ?? DEFAULT_MAX_PAGES;
    this.now = opts.now ?? Date.now;
  }

  /** `owner/repo#number` → a path segment safe to put in a URL. */
  static idFor(owner: string, repo: string, number: number): string {
    return `${owner}__${repo}__${number}`.replace(/[^A-Za-z0-9_.-]/g, "-");
  }

  /** Store (replacing any previous page for the same PR) and return `id` + `token`. */
  put(owner: string, repo: string, number: number, html: string): { id: string; token: string } {
    const id = PageStore.idFor(owner, repo, number);
    this.pages.set(id, { html, storedMs: this.now() });
    this.evict();
    return { id, token: this.sign(id) };
  }

  /**
   * The page, if the token is valid and it has not expired.
   *
   * Expiry is checked against the STORED time rather than encoded in the token,
   * so a link cannot outlive the data it points at — and re-reviewing a PR
   * refreshes both together.
   */
  get(id: string, token: string | undefined): string | null {
    const page = this.pages.get(id);
    if (!page || !token || !this.valid(id, token)) return null;
    if (this.now() - page.storedMs > this.ttlMs) {
      this.pages.delete(id);
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
    for (const [id, page] of this.pages) if (page.storedMs < cutoff) this.pages.delete(id);
    while (this.pages.size > this.maxPages) {
      const oldest = this.pages.keys().next();
      if (oldest.done) break;
      this.pages.delete(oldest.value);
    }
  }
}
