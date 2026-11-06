/**
 * Keeping on sharing, for the team-memory experiment. Once a person says yes
 * to `trail share-session` (which keeps sending unless run with `--once`), every
 * Claude Code session they start sends,
 * from a detached child of the session-start hook, what changed since the last
 * time: sessions that are new or have grown, and the setup when it changes.
 * Each is scrubbed exactly as the first send was, kept under
 * `~/.trail/share/sync/` so the person can read what went, and sent into the
 * same bundle, where Trail replaces the older copy of a session that grew.
 *
 * `--stop` ends it; `--delete <code>` takes everything back and ends it too.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { gzipSync } from "node:zlib";
import { deleteHash, slug } from "./share-bundle.js";
import { anonymize, bundleSession, MAX_GZ_BYTES, sessionCwd, sessionsSince } from "./share-session.js";
import { collectSetup } from "./share-setup.js";
import { QUIET_MS, readSyncState, syncDir, writeSyncState, type SyncState } from "./share-sync-state.js";
import type { SharedSession } from "./workspace.js";

export { maybeShareSyncInBackground, readSyncState, SYNC_EVERY_MS, syncDir, syncDue, writeSyncState, type SyncState } from "./share-sync-state.js";

/** A lock older than this was left by a child that died. */
const LOCK_STALE_MS = 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** The sessions that are new or have grown since they were last sent, and have gone quiet. */
export function changedSessions(s: SyncState, home: string, now = Date.now()) {
  const reach = Math.max(1, Math.ceil((now - s.since) / DAY_MS) + s.days);
  return sessionsSince(reach, home, now).filter((f) => now - f.mtime >= QUIET_MS && (s.sessions[f.id] ?? 0) < f.mtime);
}

type Send = (body: SharedSession) => Promise<{ id: string } | { error: string }>;

/**
 * Send what changed, one item at a time, writing the state after each, so a
 * run that dies picks up where it stopped. Skips if another run holds the lock.
 */
export async function runSync(opts: {
  home: string;
  who: string[];
  send: Send;
  trailVersion: string;
  repoOf?: (cwd: string) => string;
  env?: NodeJS.ProcessEnv;
  now?: number;
}): Promise<{ sent: number; skipped: number; error?: string } | null> {
  const now = opts.now ?? Date.now();
  const s = readSyncState(opts.env);
  if (!s || s.stoppedAt) return null;
  const dir = syncDir(opts.env);
  mkdirSync(dir, { recursive: true });
  const lock = join(dir, ".lock");
  try {
    if (now - statSync(lock).mtimeMs < LOCK_STALE_MS) return null;
  } catch {
    // no lock
  }
  writeFileSync(lock, String(process.pid));
  let sent = 0;
  let skipped = 0;
  const base = { bundle_id: s.bundleId, delete_hash: deleteHash(s.secret), trail_version: opts.trailVersion };
  try {
    const cwds = new Set<string>(s.dirs.filter((d) => existsSync(d)));
    for (const f of changedSessions(s, opts.home, now)) {
      const cwd = sessionCwd(f);
      const folder = cwd ? anonymize(cwd, opts.who).text : (f.folder ?? "");
      if (cwd && existsSync(cwd)) cwds.add(cwd);
      const b = bundleSession(f, opts.who);
      if (s.excluded.includes(folder) || b.gz.length > MAX_GZ_BYTES) {
        s.sessions[f.id] = f.mtime;
        skipped++;
        writeSyncState(s, opts.env);
        continue;
      }
      const file = join(dir, "sessions", slug(folder), `${f.id}.jsonl.gz`);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, b.gz);
      const r = await opts.send({
        ...base,
        kind: "session",
        session_id: f.id,
        repo: cwd && opts.repoOf ? opts.repoOf(cwd) : "",
        title: b.title,
        messages: b.messages,
        subagents: b.subagents,
        bytes: b.bytes,
        redacted: Object.values(b.redacted).reduce((n, c) => n + c, 0),
        transcript_gz: b.gz.toString("base64"),
      });
      if ("error" in r) return { sent, skipped, error: r.error };
      s.sessions[f.id] = f.mtime;
      sent++;
      writeSyncState(s, opts.env);
    }
    s.dirs = [...cwds].sort();
    const set = collectSetup({ home: opts.home, dirs: s.dirs, who: opts.who });
    const json = `${JSON.stringify(set.setup, null, 2)}\n`;
    const hash = createHash("sha256").update(json).digest("hex");
    if (hash !== s.setupHash) {
      writeFileSync(join(dir, "setup.json"), json);
      const r = await opts.send({
        ...base,
        kind: "setup",
        session_id: "setup",
        repo: "",
        title: "Claude setup",
        messages: 0,
        subagents: 0,
        bytes: Buffer.byteLength(json),
        redacted: Object.values(set.redacted).reduce((n, c) => n + c, 0),
        transcript_gz: gzipSync(json).toString("base64"),
      });
      if ("error" in r) return { sent, skipped, error: r.error };
      s.setupHash = hash;
      sent++;
    }
    s.lastRunAt = now;
    writeSyncState(s, opts.env);
    return { sent, skipped };
  } finally {
    rmSync(lock, { force: true });
  }
}
