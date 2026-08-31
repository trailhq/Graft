/**
 * The two identifiers, and why neither of them identifies anyone.
 *
 *   • install id — one per machine, in `~/.graft/telemetry.json`, beside the
 *     update-check cache that already lives there. Lets us count people rather
 *     than events, so a dev running forty queries is one user and not forty.
 *   • repo id — one per checkout, in `graft/.cache/`. Activation and retention
 *     for graft are per-repo facts ("did this repo ever get past build?"), and
 *     the install id alone cannot express them.
 *
 * Both are `randomUUID()`. Not a machine id, not a hash of the git remote, not
 * derived from anything real — a coin flip, written down. A hash would at least
 * be guessable by us (we could hash a public repo URL and look for it); a random
 * UUID cannot be reversed or confirmed even in principle. Deleting `~/.graft/`
 * or `graft/` deletes them, and the user simply looks like someone new.
 *
 * Every function here is fail-soft: an unwritable home is a very common state
 * (a locked-down CI image, a read-only container) and it must cost the caller
 * nothing. A failed persist yields an ephemeral id for this process — still
 * anonymous, just not stable — and never a throw.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { cacheDir, readJson, writeJsonAtomic } from '../util/state.js';

/** Machine-global telemetry state. Shares `~/.graft/` with `update-check.json`. */
export interface TelemetryState {
  installId: string;
  /** The user's choice. Absent means "never chosen" → the default (on) applies. */
  enabled?: boolean;
  /** ISO stamp of the one-time first-run notice, so it prints exactly once. */
  noticeShownAt?: string;
  /** ISO stamp of the `first_run` event. Its own field rather than "did this
   *  call mint the install id", because the postinstall hook now mints the id
   *  before any command runs — see `trackFirstRunIfNew`. */
  firstRunAt?: string;
  /** The version the `install` event was last sent for, so an upgrade counts as
   *  an install and a repeated `npm install` of the same version does not. */
  installedVersion?: string;
  /** Epoch ms of the last flush ATTEMPT, mirroring `UpdateCache.checkedAt`. */
  flushedAt?: number;
}

export function statePath(home: string = homedir()): string {
  return join(home, '.graft', 'telemetry.json');
}

export function readState(home?: string): TelemetryState | null {
  return readJson<TelemetryState>(statePath(home));
}

/** Read-modify-write. Not atomic across processes; a lost update costs at most a
 *  duplicated notice or an extra flush attempt, never corruption. */
export function patchState(patch: Partial<TelemetryState>, home?: string): TelemetryState {
  const next: TelemetryState = { ...(readState(home) ?? { installId: randomUUID() }), ...patch };
  try { writeJsonAtomic(statePath(home), next); } catch { /* unwritable home — in-memory only */ }
  return next;
}

export interface Install {
  id: string;
  /** True when this call minted the id, i.e. this is the machine's first run. */
  firstRun: boolean;
}

/** The install id, minted on first call. */
export function installId(home?: string): Install {
  const existing = readState(home);
  if (existing?.installId) return { id: existing.installId, firstRun: false };
  const id = randomUUID();
  try {
    writeJsonAtomic(statePath(home), { ...(existing ?? {}), installId: id } satisfies TelemetryState);
    return { id, firstRun: true };
  } catch {
    // Unwritable home: use the id for this process rather than failing closed.
    // Reported as firstRun:false so a machine that can never persist doesn't
    // send a first_run event on every single command.
    return { id, firstRun: false };
  }
}

/**
 * The repo id, in `graft/.cache/` rather than `.graft/config.json`.
 *
 * `.graft/config.json` would have been the tidier home, but writing it runs
 * `ensureBuildConfigIgnored`, which appends to the repo's `.gitignore`. Minting
 * an id during a read-only `graft ask` must not modify a file the user has
 * committed. `graft/.cache/` is already derived, already git-ignored, and
 * already where every other per-repo sidecar lives.
 */
export function repoId(repo: string): string {
  const path = join(cacheDir(repo), 'telemetry-repo-id.json');
  const existing = readJson<{ repoId?: string }>(path);
  if (existing?.repoId) return existing.repoId;
  const id = randomUUID();
  try { writeJsonAtomic(path, { repoId: id }); } catch { /* unwritable — ephemeral */ }
  return id;
}
