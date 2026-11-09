/**
 * Host dialects (design 4.16, 0 rule 7): the one place a reader learns how a
 * host writes its transcript. Claude Code's dialect is 1a's readers as they
 * are; Codex's is `codex.ts`. Every reader that walks a transcript (the
 * skills session's catch-up, the save and lesson gates, the receipts) takes
 * the dialect from the context it already has (`ctx.host`, a receipt's
 * `host`), so no module outside `claude.ts`, `codex.ts` and this file parses
 * a host's lines. Hosts with no dialect (Cursor, Copilot, Gemini, unknown)
 * get none: their transcripts are not folded.
 */
import { lstatSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { lineEvents, readNewEvents, typedText, type EventReadOptions, type TraceEvent } from './claude.js';
import type { Memo } from './cursor.js';
import { codexLineEvents, codexMeta, codexTranscriptOk, codexTypedByPerson, readNewCodexEvents } from './codex.js';
import type { SkillSessionState } from './types.js';

export interface DialectReadOptions extends EventReadOptions {
  /** Codex: the session state whose typed hashes decide the person's lines (P30). Claude ignores it. */
  state?: SkillSessionState | null;
}

type Typed = Extract<TraceEvent, { kind: 'typed' }>;

export interface HostDialect {
  host: 'claude' | 'codex';
  readNewEvents(path: string, cursorPath: string, opts?: DialectReadOptions): TraceEvent[];
  /** Events of one parsed line, for the readers that walk a tail (save gate, tamper, typed line at an offset). */
  lineEvents(entry: unknown, memo: unknown, offset?: number, env?: NodeJS.ProcessEnv): TraceEvent[];
  /** The receipt's transcript is this session's own file where this host keeps it (D82's first half). */
  transcriptOk(r: { transcriptPath: string; session: string }, env?: NodeJS.ProcessEnv): boolean;
  /** Whether a typed event counts as the person's (Claude: isTypedByPerson; Codex: P30). */
  typedByPerson(ev: Typed, st: SkillSessionState | null, env?: NodeJS.ProcessEnv): boolean;
  hostName: string; // 'Claude Code' | 'Codex', for words
  /** The memo a reader of the file's tail starts with (Codex: the session's own folder, from line 1), so a tail that
   *  begins mid-session still knows where relative paths point (review). Claude's lines carry their own cwd. */
  tailMemo?(path: string, env?: NodeJS.ProcessEnv): Memo;
}

const memoOf = (memo: unknown): Memo => (memo && typeof memo === 'object' && !Array.isArray(memo) ? (memo as Memo) : {});

/** realpath, or null when the path doesn't resolve. */
function real(p: string): string | null {
  try {
    return realpathSync(p);
  } catch {
    return null;
  }
}

/** Where Claude Code keeps its transcripts: `~/.claude/projects` (HOME from env) and `$CLAUDE_CONFIG_DIR/projects`. */
function claudeProjects(env: NodeJS.ProcessEnv): string[] {
  const roots = [join(env.HOME || homedir(), '.claude', 'projects')];
  if (env.CLAUDE_CONFIG_DIR) roots.push(join(env.CLAUDE_CONFIG_DIR, 'projects'));
  return roots.flatMap((r) => {
    const p = real(r);
    return p ? [p] : [];
  });
}

/**
 * Claude Code (g7, D74): `<projects>/<folder>/<session_id>.jsonl`, compared through realpath, so a link from the
 * projects folder to a file elsewhere, a copy in /tmp or another session's file is not it.
 */
function claudeTranscriptOk(r: { transcriptPath: string; session: string }, env: NodeJS.ProcessEnv = process.env): boolean {
  if (!r.transcriptPath || !isAbsolute(r.transcriptPath)) return false;
  const file = real(r.transcriptPath);
  if (!file || basename(file) !== `${r.session}.jsonl`) return false;
  try {
    if (!lstatSync(file).isFile()) return false;
  } catch {
    return false;
  }
  const folder = dirname(file);
  return claudeProjects(env).some((root) => dirname(folder) === root && folder !== root);
}

export const CLAUDE_DIALECT: HostDialect = Object.freeze({
  host: 'claude' as const,
  hostName: 'Claude Code',
  readNewEvents: (path: string, cursorPath: string, opts: DialectReadOptions = {}) => readNewEvents(path, cursorPath, opts),
  lineEvents: (entry: unknown, memo: unknown, offset?: number, env?: NodeJS.ProcessEnv) => lineEvents(entry, memoOf(memo), offset, env),
  transcriptOk: claudeTranscriptOk,
  // Claude's reader emits a typed event only for a line isTypedByPerson accepts.
  typedByPerson: (ev: Typed) => ev.kind === 'typed' && ev.text.trim() !== '',
});

export const CODEX_DIALECT: HostDialect = Object.freeze({
  host: 'codex' as const,
  hostName: 'Codex',
  readNewEvents: (path: string, cursorPath: string, opts: DialectReadOptions = {}) => readNewCodexEvents(path, cursorPath, opts),
  lineEvents: (entry: unknown, memo: unknown, offset?: number, env?: NodeJS.ProcessEnv) => codexLineEvents(entry, memoOf(memo), offset, env),
  transcriptOk: codexTranscriptOk,
  typedByPerson: (ev: Typed, st: SkillSessionState | null, env?: NodeJS.ProcessEnv) => ev.kind === 'typed' && codexTypedByPerson(ev.text, st, env),
  tailMemo: (path: string): Memo => {
    const cwd = codexMeta(path)?.cwd;
    return cwd ? { cwd } : {};
  },
});

/** claude and codex only; null elsewhere (the fold doesn't run). */
export function dialectFor(host: string): HostDialect | null {
  return host === 'claude' ? CLAUDE_DIALECT : host === 'codex' ? CODEX_DIALECT : null;
}

/** A dialect and the session state it judges typed lines with: what a reader at an offset needs. */
export interface DialectUse { dialect: HostDialect; st: SkillSessionState | null }
export const CLAUDE_USE: DialectUse = Object.freeze({ dialect: CLAUDE_DIALECT, st: null });
/** The session's host dialect and its state; a host with no dialect reads as Claude's (D133). */
export const useFor = (host: string, st: SkillSessionState | null): DialectUse => ({ dialect: dialectFor(host) ?? CLAUDE_DIALECT, st });

/** The person's words on one parsed line, as `use`'s dialect judges them; "" when the line isn't theirs. */
export function typedOnLine(entry: unknown, use: DialectUse, env: NodeJS.ProcessEnv): string {
  // Claude: exactly 1a's typedText (the line's own flags decide).
  if (use.dialect.host === 'claude') return typedText(entry, env);
  for (const ev of use.dialect.lineEvents(entry, {}, undefined, env)) {
    if (ev.kind === 'typed' && use.dialect.typedByPerson(ev, use.st, env)) return ev.text;
  }
  return '';
}
