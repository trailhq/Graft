/**
 * Whether `trail share-session`'s keep-sending is on, and starting its detached run.
 * Kept apart from share-sync.ts so the session-start hook loads only this:
 * one small file read, and a spawn when a run is due.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { graftCliPath } from "../claude/paths.js";
import { trailHome } from "../notes/trail-home.js";

export interface SyncState {
  bundleId: string;
  /** The delete code's secret part; Trail keeps only its sha256. */
  secret: string;
  /** When the person said yes. */
  since: number;
  /** How far back the first send reached, in days; later sends never reach further. */
  days: number;
  /** The Trail it goes to. */
  url: string;
  /** Folders the person left out, by label: never sent. */
  excluded: string[];
  /** The folders sessions ran in, on this laptop: where the setup's project files are read. */
  dirs: string[];
  /** Each session as last sent (or passed over), by its last-written time. */
  sessions: Record<string, number>;
  /** sha256 of the setup as last sent. */
  setupHash?: string;
  lastRunAt?: number;
  stoppedAt?: number;
}

/** A sync runs at most this often, however many sessions start. */
export const SYNC_EVERY_MS = 15 * 60 * 1000;
/** A session written to in the last ten minutes is still going: it's sent next time. */
export const QUIET_MS = 10 * 60 * 1000;
export function syncDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(trailHome(env), "share", "sync");
}

function stateFile(env?: NodeJS.ProcessEnv): string {
  return join(dirname(syncDir(env)), "sync.json");
}

export function readSyncState(env?: NodeJS.ProcessEnv): SyncState | null {
  try {
    const s = JSON.parse(readFileSync(stateFile(env), "utf8")) as SyncState;
    return typeof s.bundleId === "string" && typeof s.secret === "string" && s.sessions && typeof s.sessions === "object" ? { ...s, dirs: Array.isArray(s.dirs) ? s.dirs : [] } : null;
  } catch {
    return null;
  }
}

export function writeSyncState(s: SyncState, env?: NodeJS.ProcessEnv): void {
  mkdirSync(dirname(stateFile(env)), { recursive: true });
  writeFileSync(stateFile(env), `${JSON.stringify(s, null, 2)}\n`, { mode: 0o600 });
}

/** On, and not run in the last {@link SYNC_EVERY_MS}. */
export function syncDue(s: SyncState | null, now = Date.now()): s is SyncState {
  return !!s && !s.stoppedAt && (s.lastRunAt === undefined || now - s.lastRunAt >= SYNC_EVERY_MS);
}

/**
 * From the session-start hook: start a detached sync when one is due. Reads
 * one small file and never waits. Returns whether a child was started.
 */
export function maybeShareSyncInBackground(env: NodeJS.ProcessEnv = process.env, now = Date.now()): boolean {
  try {
    const s = readSyncState(env);
    if (!syncDue(s, now)) return false;
    // Before the spawn, so a child that dies costs one round, not one per session.
    writeSyncState({ ...s, lastRunAt: now }, env);
    const child = spawn(process.execPath, [graftCliPath(), "_share-sync"], { detached: true, stdio: "ignore", windowsHide: true, env });
    child.unref();
    return true;
  } catch {
    return false; // no spawn here (sandbox, ENOMEM): the next session tries
  }
}
