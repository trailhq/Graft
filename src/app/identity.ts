/**
 * Who the App is, to GitHub.
 *
 * A GitHub App authenticates twice over: it signs a short JWT with its private
 * key to prove it is the App, then trades that for an *installation* token scoped
 * to one repository owner. The installation token is what matters here — it is
 * the reason this exists at all. A workflow on a fork's pull request gets a
 * read-only token and cannot comment; an App's installation token belongs to the
 * base repository, so a fork PR is no different from any other.
 *
 * `node:crypto` signs the JWT, so there is no dependency to audit for something
 * that handles a private key.
 */
import { createHmac, createSign, timingSafeEqual } from "node:crypto";

/** GitHub rejects a JWT older than 60s or more than 10 minutes in the future. */
const JWT_TTL_S = 540; // 9 minutes, inside the limit with room for clock skew
/** Renew this long before expiry rather than racing it. */
const RENEW_MARGIN_MS = 60_000;

const b64url = (b: Buffer | string): string =>
  Buffer.from(b).toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");

export interface AppCredentials {
  appId: string;
  /** PEM, as GitHub hands it over. */
  privateKey: string;
}

/**
 * A signed App JWT.
 *
 * `iat` is backdated a minute: GitHub compares against ITS clock, and a server
 * running even slightly fast has its tokens rejected as "issued in the future" —
 * a failure that looks like a bad key and is not.
 */
export function appJwt(creds: AppCredentials, nowMs: number): string {
  const iat = Math.floor(nowMs / 1000) - 60;
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = b64url(JSON.stringify({ iat, exp: iat + JWT_TTL_S, iss: creds.appId }));
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${payload}`);
  return `${header}.${payload}.${b64url(signer.sign(creds.privateKey))}`;
}

export interface TokenResponse {
  token: string;
  expires_at: string;
}

/** Minimal shape of `fetch`, so tests need no network and no mocking library. */
export type Fetch = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{
  ok: boolean;
  status: number;
  text: () => Promise<string>;
}>;

interface CacheEntry {
  token: string;
  expiresMs: number;
}

/**
 * Installation tokens, fetched once and reused until they are nearly expired.
 *
 * Tokens last an hour and a busy repository can fire a dozen webhooks a minute;
 * without the cache every one of them spends a round trip and a signature.
 */
/**
 * The installation id for one repository.
 *
 * Every existing caller gets the id from a webhook payload, because every
 * existing caller is reacting to one. A request that names a repository instead
 * has to look it up, and this is the only endpoint that answers it: it is
 * App-JWT authed, so it works before any installation token exists.
 *
 * Returns null when the App is not installed on the repository — which is the
 * expected answer for "the user pasted a repo we cannot see", not an error.
 */
/**
 * Headers for a GitHub REST call, with or without a token.
 *
 * An empty token means anonymous, and anonymous has to mean NO authorization
 * header — `Bearer ` with nothing after it is a 401, not a fallback. That
 * distinction is the whole reason this is a function: a public repository read
 * without an installation goes down exactly this path.
 */
export function ghHeaders(token: string): Record<string, string> {
  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    "user-agent": "graft-app",
  };
  if (token) headers.authorization = `Bearer ${token}`;
  return headers;
}

/**
 * An installation token for reading PUBLIC repositories the App is not
 * installed on.
 *
 * GitHub answers any public resource to any installation token, at 5,000
 * requests an hour. Anonymous answers the same resources at 60 an hour for the
 * whole box, which one repository's pull-request walk spends in a minute — so
 * without this, the second public repo of the hour reads as "we cannot see it".
 *
 * `owner` is our own account, so this borrows OUR installation's rate limit
 * rather than some customer's. Falls back to the first installation, and to
 * null when the App has none, in which case the caller reads anonymously.
 */
export async function publicReadInstallation(
  creds: AppCredentials,
  owner: string,
  fetchImpl: Fetch,
  nowMs: number = Date.now(),
  api = "https://api.github.com",
): Promise<number | null> {
  const res = await fetchImpl(`${api}/app/installations?per_page=100`, {
    headers: {
      authorization: `Bearer ${appJwt(creds, nowMs)}`,
      accept: "application/vnd.github+json",
      "user-agent": "graft-app",
    },
  });
  if (!res.ok) return null;
  const list = JSON.parse(await res.text()) as Array<{ id?: number; account?: { login?: string } }>;
  if (!Array.isArray(list) || list.length === 0) return null;
  const wanted = owner.toLowerCase();
  const mine = list.find((i) => (i.account?.login ?? "").toLowerCase() === wanted);
  return (mine ?? list[0]).id ?? null;
}

export async function installationFor(
  creds: AppCredentials,
  owner: string,
  repo: string,
  fetchImpl: Fetch,
  nowMs: number = Date.now(),
  api = "https://api.github.com",
): Promise<number | null> {
  const res = await fetchImpl(`${api}/repos/${owner}/${repo}/installation`, {
    headers: {
      authorization: `Bearer ${appJwt(creds, nowMs)}`,
      accept: "application/vnd.github+json",
      "user-agent": "graft-app",
    },
  });
  if (res.status === 404) return null;
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`installation lookup for ${owner}/${repo} failed: ${res.status} ${body.slice(0, 200)}`);
  }
  const parsed = JSON.parse(await res.text()) as { id?: number };
  return typeof parsed.id === "number" ? parsed.id : null;
}

/**
 * Why a repository is unreachable, and where to send the user to fix it.
 *
 * Two failures look identical from `/repos/{o}/{r}/installation` — both 404 —
 * and they need different sentences and different links. Either the App is not
 * on the account at all, so they install it; or it is installed and this
 * repository simply is not in its selected list, so they edit that list. Telling
 * someone to install an App they already installed is the kind of dead end that
 * ends the session.
 *
 * ownerId is the account's numeric id, which preselects the right account on
 * GitHub's install screen. There is no equivalent for preselecting a repository;
 * GitHub owns that checkbox list.
 */
export interface RepoAccessGap {
  reason: "not_installed" | "repo_not_selected";
  ownerId: number | null;
  installationId: number | null;
}

/** Which of the two gaps applies to owner/repo. */
export async function repoAccessGap(
  creds: AppCredentials,
  owner: string,
  fetchImpl: Fetch,
  nowMs: number = Date.now(),
  api = "https://api.github.com",
): Promise<RepoAccessGap> {
  const headers = {
    authorization: `Bearer ${appJwt(creds, nowMs)}`,
    accept: "application/vnd.github+json",
    "user-agent": "graft-app",
  };
  // An account is an org or a user and the endpoints differ, so try the org one
  // and fall back rather than making the caller know which it is.
  for (const path of [`/orgs/${owner}/installation`, `/users/${owner}/installation`]) {
    try {
      const res = await fetchImpl(`${api}${path}`, { headers });
      if (!res.ok) continue;
      const parsed = JSON.parse(await res.text()) as { id?: number; account?: { id?: number } };
      return {
        reason: "repo_not_selected",
        ownerId: parsed.account?.id ?? null,
        installationId: parsed.id ?? null,
      };
    } catch {
      // Try the other shape; a network failure here only costs a less specific
      // message, never the whole answer.
    }
  }
  return { reason: "not_installed", ownerId: await ownerIdFor(owner, fetchImpl, api), installationId: null };
}

/** The account's numeric id, for preselecting it on the install screen. */
async function ownerIdFor(owner: string, fetchImpl: Fetch, api: string): Promise<number | null> {
  try {
    // Unauthenticated: a public account's id is public, and this runs on a path
    // where the App has no installation token to use anyway.
    const res = await fetchImpl(`${api}/users/${owner}`, {
      headers: { accept: "application/vnd.github+json", "user-agent": "graft-app" },
    });
    if (!res.ok) return null;
    return (JSON.parse(await res.text()) as { id?: number }).id ?? null;
  } catch {
    return null;
  }
}

export class InstallationTokens {
  private readonly cache = new Map<number, CacheEntry>();

  constructor(
    private readonly creds: AppCredentials,
    private readonly fetchImpl: Fetch,
    private readonly now: () => number = Date.now,
    private readonly api = "https://api.github.com",
  ) {}

  async get(installationId: number): Promise<string> {
    const hit = this.cache.get(installationId);
    if (hit && hit.expiresMs - RENEW_MARGIN_MS > this.now()) return hit.token;

    const res = await this.fetchImpl(`${this.api}/app/installations/${installationId}/access_tokens`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${appJwt(this.creds, this.now())}`,
        accept: "application/vnd.github+json",
        "user-agent": "graft-app",
      },
    });
    const body = await res.text();
    if (!res.ok) {
      // The body carries GitHub's reason ("integration not found", a key that does
      // not match the app id); losing it turns every setup mistake into "401".
      throw new Error(`installation token for ${installationId} failed: ${res.status} ${body.slice(0, 200)}`);
    }
    const parsed = JSON.parse(body) as TokenResponse;
    this.cache.set(installationId, { token: parsed.token, expiresMs: Date.parse(parsed.expires_at) });
    return parsed.token;
  }

  /** Drop a token GitHub has rejected, so the next call fetches a fresh one. */
  invalidate(installationId: number): void {
    this.cache.delete(installationId);
  }
}

/**
 * Is this delivery really from GitHub?
 *
 * The webhook endpoint is public, and everything downstream — cloning a repo,
 * posting as the App — happens on its say-so. Compared in constant time because
 * a byte-at-a-time comparison leaks the expected digest to anyone willing to
 * measure, and forging a signature is a total compromise of the endpoint.
 */
export function verifySignature(secret: string, body: string, header: string | undefined): boolean {
  if (!header) return false;
  const expected = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
  const a = Buffer.from(expected);
  const b = Buffer.from(header);
  return a.length === b.length && timingSafeEqual(a, b);
}
