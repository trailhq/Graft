/**
 * Reading a Codex rollout (design 4.15): `~/.codex/sessions/YYYY/MM/DD/
 * rollout-<time>-<session>.jsonl`, one `{timestamp, type, payload}` per line,
 * `session_meta` first. The reader turns its lines into 1a's `TraceEvent`s,
 * so the fold, runs, checks, compile and credit are host-free from there on.
 *
 * Whose words a line holds is not in the line: Codex puts AGENTS.md text,
 * environment context and hook context in user-role messages too. So a typed
 * line counts as the person's only when its keyed hash is one the
 * UserPromptSubmit hook recorded from the prompt the person submitted (P30,
 * R7); anything else is injected. With no session state, or no key, nothing
 * is typed.
 *
 * A command's exit survives only as text in its output's header (P34): the
 * header decides, a structured `CommandExecution` exit beats it, and a call
 * whose exit never shows stays open, which a run's verdict reads as not
 * passed. Imported rollouts (Claude Code sessions Codex copied in) are never
 * Codex work (P39); compressed `.jsonl.zst` files are never read (P40).
 * Never throws.
 */
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { closeSync, lstatSync, openSync, readFileSync, writeSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { readAppended, type Memo } from './cursor.js';
import { failedText } from './failure.js';
import { ensurePrivateDir } from './state.js';
import { trailHome } from '../notes/trail-home.js';
import type { EventReadOptions, TraceEvent } from './claude.js';
import type { SkillSessionState } from './types.js';
import { isForkedRollout, isImportedRollout } from './codex-meta.js';
import { argvCommand, codexExitOf, outputBody, outputText, patchFiles, shellPatchFiles } from './codex-exec.js';

export type { CodexMeta } from './types.js';
export { codexExitOf } from './codex-exec.js';
export { codexHome, codexMeta, codexTranscriptOk, isForkedRollout, isImportedRollout } from './codex-meta.js';

const MAX_LINE = 2 * 1024 * 1024;
const MAX_TEXT = 40_000;
const KEEP_HEAD = 8_000;
/** A running command's output, joined across write_stdin reads: head and tail kept. */
const JOIN_KEEP = 8 * 1024;
const MAX_OPEN = 500;
const MAX_RUNNING = 50;
const TYPED_KEEP = 20;

const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);

/* ----------------------------------------------------------- typed (P30) */

/**
 * D138 (3): `~/.trail/state/typed-key`, 32 random bytes as hex, 0600; made only when `create`. Never `~/.trail/key`,
 * which belongs to another feature. null when missing, a link (the file or the state folder), or odd.
 */
function promptKey(env: NodeJS.ProcessEnv, create: boolean): Buffer | null {
  const dir = join(trailHome(env), 'state');
  const path = join(dir, 'typed-key');
  const linked = (): boolean => {
    try {
      return lstatSync(dir).isSymbolicLink();
    } catch {
      return false;
    }
  };
  const read = (): Buffer | null => {
    try {
      if (linked()) return null;
      if (!lstatSync(path).isFile()) return null;
      const t = readFileSync(path, 'utf8').trim();
      return /^[0-9a-f]{64}$/.test(t) ? Buffer.from(t, 'hex') : null;
    } catch {
      return null;
    }
  };
  const have = read();
  if (have || !create) return have;
  try {
    ensurePrivateDir(trailHome(env));
    ensurePrivateDir(dir);
    if (linked()) return null;
    const fd = openSync(path, 'wx', 0o600);
    try {
      writeSync(fd, `${randomBytes(32).toString('hex')}\n`);
    } finally {
      closeSync(fd);
    }
  } catch {
    /* another hook made it first, or the home can't be written: read what is there */
  }
  return read();
}

/** R7, D138: the keyed hash (HMAC-SHA256 with ~/.trail/state/typed-key, 16 hex) of a prompt's trimmed text; null with no key. */
export function codexTypedSha(text: string, env: NodeJS.ProcessEnv = process.env, opts: { create?: boolean } = {}): string | null {
  const key = promptKey(env, opts.create === true);
  return key ? createHmac('sha256', key).update(String(text).trim(), 'utf8').digest('hex').slice(0, 16) : null;
}

/** For the prompt hook (c8): the submitted prompt's keyed hash into `st.codex.typedShas`, the last 20. Makes the key. */
export function noteCodexPrompt(st: SkillSessionState, prompt: string, env: NodeJS.ProcessEnv = process.env): void {
  const sha = codexTypedSha(prompt, env, { create: true });
  if (!sha) return;
  const cur = st.codex && typeof st.codex === 'object' ? st.codex : { meta: null, typedShas: [] };
  const shas = Array.isArray(cur.typedShas) ? cur.typedShas.filter((s) => typeof s === 'string') : [];
  st.codex = { meta: cur.meta ?? null, typedShas: [...shas, sha].slice(-TYPED_KEEP) };
}

/** P30: a typed line is the person's when the prompt hook recorded its keyed hash in this session. */
export function codexTypedByPerson(text: string, st: SkillSessionState | null | undefined, env: NodeJS.ProcessEnv = process.env): boolean {
  const shas = st?.codex?.typedShas;
  if (!Array.isArray(shas) || !shas.length || !text.trim()) return false;
  const sha = codexTypedSha(text, env);
  return sha !== null && shas.includes(sha);
}

/* ------------------------------------------------------------ line events */

interface Open { name: string; shell: boolean; cmd?: string; turn?: string }
interface Running { id: string; cmd?: string; turn?: string; head: string; tail: string }
interface CodexMemoShape { cwd?: string; branch?: string; turn?: string; calls: Record<string, Open>; running: Record<string, Running>; stdin: Record<string, string>; exits: Record<string, number>; said: string[]; compactAt?: string }
/** The reader's state carried from line to line and saved with the cursor: open calls, running commands, the turn. */
export type CodexMemo = Memo;

/** The keys fed to each running session in this read, by memo: in memory only, never in the saved cursor. */
const KEYS_KEEP = 16 * 1024;
const fedKeys = new WeakMap<object, Record<string, string>>();
function keyed(memo: Memo, session: string, chars: string): string {
  const all = fedKeys.get(memo) ?? {};
  fedKeys.set(memo, all);
  all[session] = `${all[session] ?? ''}${chars}`.slice(-KEYS_KEEP);
  return all[session]!;
}

function box(memo: Memo): CodexMemoShape {
  const m = memo as unknown as Partial<CodexMemoShape>;
  const obj = (v: unknown) => v && typeof v === 'object' && !Array.isArray(v);
  if (!obj(m.calls)) m.calls = {};
  if (!obj(m.running)) m.running = {};
  if (!obj(m.stdin)) m.stdin = {};
  if (!obj(m.exits)) m.exits = {};
  if (!Array.isArray(m.said)) m.said = [];
  return m as CodexMemoShape;
}

function trim(rec: Record<string, unknown>, max: number): void {
  const keys = Object.keys(rec);
  for (const k of keys.slice(0, Math.max(0, keys.length - max))) delete rec[k];
}

const clip = (t: string) => (t.length > MAX_TEXT ? `${t.slice(0, KEEP_HEAD)}\n…\n${t.slice(-(MAX_TEXT - KEEP_HEAD))}` : t);
const sha8 = (t: string) => createHash('sha256').update(t).digest('hex').slice(0, 16);

/** The text parts of a message's content (input_text, output_text, text). */
function partsText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.flatMap((p) => (p && typeof p === 'object' && typeof (p as { text?: unknown }).text === 'string' ? [(p as { text: string }).text] : [])).join('\n');
}

function args(v: unknown): Record<string, unknown> | null {
  if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>;
  if (typeof v !== 'string') return null;
  try {
    const o = JSON.parse(v);
    return o && typeof o === 'object' && !Array.isArray(o) ? o : null;
  } catch {
    return null;
  }
}

/** A folder named by a call, against the turn's folder when relative. */
function folder(dir: unknown, m: CodexMemoShape): string | undefined {
  const d = str(dir);
  if (!d) return m.cwd;
  return isAbsolute(d) ? d : m.cwd ? resolve(m.cwd, d) : undefined;
}

/** The shell command a call runs, by tool: exec_command's cmd, shell's vector, shell_command's line, local_shell_call's action. */
function shellOf(name: string, a: Record<string, unknown>): { cmd: string; dir: unknown } | null {
  if (name === 'exec_command') return str(a.cmd) ? { cmd: a.cmd as string, dir: a.workdir } : null;
  if (name === 'shell') {
    const cmd = argvCommand(a.command);
    return cmd ? { cmd, dir: a.workdir } : null;
  }
  if (name === 'shell_command') return str(a.command) ? { cmd: a.command as string, dir: a.workdir } : null;
  return null;
}

/** The events one parsed rollout line holds. `offset`: where the line starts in the file. */
function eventsOf(e: { timestamp?: unknown; type?: unknown; payload?: unknown }, memo: Memo, out: TraceEvent[], offset: number | undefined): void {
  const p = e.payload && typeof e.payload === 'object' && !Array.isArray(e.payload) ? (e.payload as Record<string, any>) : null;
  if (!p) return;
  const m = box(memo);
  const at = typeof e.timestamp === 'string' ? e.timestamp : '';
  const where = offset === undefined ? {} : { offset };
  const ctx = () => ({ ...(m.cwd ? { cwd: m.cwd } : {}), ...(m.branch ? { branch: m.branch } : {}) });
  const assistant = (text: string) => {
    const t = text.trim();
    if (!t) return;
    const h = sha8(t);
    if (m.said.includes(h)) return;
    m.said = [...m.said, h].slice(-20);
    out.push({ kind: 'assistant', text: clip(t), at, ...where });
  };
  const typed = (text: string) => {
    const t = text.trim();
    if (!t) return;
    m.said = [];
    out.push({ kind: 'typed', text: t, at, ...where });
  };
  const injected = (text: string) => {
    const t = text.trim();
    if (t) out.push({ kind: 'injected', text: clip(t), at, ...where });
  };
  const compaction = () => {
    if (at && m.compactAt === at) return;
    m.compactAt = at;
    out.push({ kind: 'compaction', at, ...where });
  };
  const call = (id: string, name: string, input: unknown, shell: boolean, cmd?: string, cwd?: string) => {
    m.calls[id] = { name, shell, ...(cmd ? { cmd } : {}), ...(m.turn ? { turn: m.turn } : {}) };
    trim(m.calls as Record<string, unknown>, MAX_OPEN);
    const c = ctx();
    out.push({ kind: 'tool_call', id, name, input, at, ...where, ...c, ...(cwd ? { cwd } : {}) });
  };
  const result = (id: string, code: number | null, text: string, shell: boolean) => {
    const failed = code !== null && code !== 0;
    const shown = failed ? `Exit code ${code}\n${text}` : text;
    const ok = shell ? code === 0 && !failedText(text) : !failed;
    out.push({ kind: 'tool_result', id, ok, text: clip(shown), at, ...where, isError: failed });
  };
  const closeRunning = (key: string, code: number, more: string) => {
    const r = m.running[key]!;
    delete m.running[key];
    for (const [k, v] of Object.entries(m.stdin)) if (v === key) delete m.stdin[k];
    result(r.id, code, [r.head, r.tail, more].filter(Boolean).join('\n'), true);
  };
  const join = (r: Running, text: string) => {
    if (r.head.length < JOIN_KEEP) {
      const room = JOIN_KEEP - r.head.length;
      r.head += (r.head ? '\n' : '') + text.slice(0, room);
      text = text.slice(room);
    }
    if (text) r.tail = `${r.tail}\n${text}`.slice(-JOIN_KEEP);
  };

  if (e.type === 'session_meta') {
    m.cwd = str(p.cwd) ?? m.cwd;
    m.branch = str(p.git?.branch) ?? m.branch;
    return;
  }
  if (e.type === 'turn_context') {
    m.cwd = str(p.cwd) ?? m.cwd;
    m.branch = str(p.git_branch) ?? m.branch;
    if (str(p.turn_id)) m.turn = p.turn_id;
    m.said = [];
    return;
  }
  if (e.type === 'compacted') return compaction();
  if (e.type === 'event_msg') {
    switch (p.type) {
      case 'task_started':
        if (str(p.turn_id)) m.turn = p.turn_id;
        m.said = [];
        return;
      case 'user_message':
        return typed(typeof p.message === 'string' ? p.message : '');
      case 'agent_message':
        return assistant(typeof p.message === 'string' ? p.message : '');
      case 'context_compacted':
        return compaction();
      case 'item_completed': {
        const it = p.item && typeof p.item === 'object' ? p.item : null;
        if (!it) return;
        if (it.type === 'UserMessage') return typed(partsText(it.content));
        if (it.type === 'AgentMessage') return assistant(partsText(it.content));
        if (it.type === 'CommandExecution') return structured(str(it.id), argvCommand(it.command), it.exit_code, typeof it.aggregated_output === 'string' ? it.aggregated_output : '');
        return;
      }
      case 'exec_command_end':
        return structured(str(p.call_id), argvCommand(p.command), p.exit_code, typeof p.aggregated_output === 'string' ? p.aggregated_output : '');
      default:
        return;
    }
  }
  if (e.type !== 'response_item') return;
  switch (p.type) {
    case 'message': {
      const text = partsText(p.content);
      if (p.role === 'assistant') return assistant(text);
      return injected(text); // user (AGENTS.md, environment context, the prompt's copy), developer, system
    }
    case 'function_call': {
      const id = str(p.call_id);
      const name = str(p.name);
      const a = args(p.arguments);
      if (!id || !name || !a) return;
      if (name === 'write_stdin') {
        const session = a.session_id !== undefined && a.session_id !== null ? String(a.session_id) : null;
        if (session !== null) m.stdin[id] = session;
        trim(m.stdin, MAX_RUNNING);
        // Keystrokes into a running command (a shell, a REPL) can run anything, so they are a call of their own,
        // with every key fed to that session so far in this read (a command split over writes is whole), never
        // kept on disk: a login's password can be among them (review).
        const chars = typeof a.chars === 'string' ? a.chars : '';
        if (session !== null && chars) call(id, 'write_stdin', { session_id: session, chars: keyed(memo, session, chars) }, false);
        return;
      }
      const sh = shellOf(name, a);
      if (sh) return shellCall(id, sh.cmd, folder(sh.dir, m));
      if (name === 'apply_patch') return edits(id, a.input ?? a.patch);
      return call(id, name, a, false);
    }
    case 'local_shell_call': {
      const id = str(p.call_id) ?? str(p.id);
      const cmd = argvCommand(p.action?.command);
      if (id && cmd) shellCall(id, cmd, folder(p.action?.working_directory, m));
      return;
    }
    case 'custom_tool_call': {
      const id = str(p.call_id);
      const name = str(p.name);
      if (!id || !name) return;
      if (name === 'apply_patch') return edits(id, p.input);
      return call(id, name, { input: p.input }, false);
    }
    case 'function_call_output':
    case 'custom_tool_call_output': {
      const id = str(p.call_id);
      if (!id) return;
      const text = outputText(p.output);
      const exit = codexExitOf(text);
      const viaStdin = m.stdin[id];
      if (viaStdin !== undefined) {
        delete m.stdin[id];
        if (m.calls[id]) {
          delete m.calls[id];
          out.push({ kind: 'tool_result', id, ok: true, text: '', at, ...where, isError: false });
        }
        const r = m.running[viaStdin];
        if (!r) return;
        if (exit && 'code' in exit) return closeRunning(viaStdin, exit.code, outputBody(text));
        join(r, outputBody(text));
        return;
      }
      const open = m.calls[id];
      delete m.calls[id];
      const shell = open ? open.shell : true; // a call never seen (read before this window) is judged as a command
      const known = m.exits[id];
      delete m.exits[id];
      if (shell && exit && 'running' in exit && known === undefined) {
        const key = String(exit.running);
        m.running[key] = { id, ...(open?.cmd ? { cmd: open.cmd } : {}), ...(open?.turn ? { turn: open.turn } : {}), head: '', tail: '' };
        join(m.running[key]!, outputBody(text));
        trim(m.running as Record<string, unknown>, MAX_RUNNING);
        return;
      }
      const code = known !== undefined ? known : exit && 'code' in exit ? exit.code : null;
      return result(id, code, outputBody(text), shell);
    }
    default:
      return;
  }

  function edits(id: string, patch: unknown): void {
    const files = patchFiles(patch);
    const list = files.length ? files : [''];
    list.forEach((f, i) => call(i === 0 ? id : `${id}#${i + 1}`, 'Edit', { file_path: f && m.cwd && !isAbsolute(f) ? resolve(m.cwd, f) : f }, false));
    for (let i = 2; i <= list.length; i++) delete m.calls[`${id}#${i}`];
  }

  /**
   * A shell call, and when it runs apply_patch (`apply_patch <<'EOF'`, `["apply_patch", patch]`, after a `cd`), which
   * Codex applies itself, one Edit per file it names as well (review): written through the shell, a patch to
   * ~/.trail was no edit to the tamper checks.
   */
  function shellCall(id: string, cmd: string, cwd: string | undefined): void {
    call(id, 'Bash', { command: cmd }, true, cmd, cwd);
    shellPatchFiles(cmd, cwd ?? m.cwd).forEach((f, i) => {
      const k = `${id}#patch${i + 1}`;
      call(k, 'Edit', { file_path: f }, false);
      delete m.calls[k];
    });
  }

  /** A structured exit: for the open call it names (by id, else by its command on this turn), it decides ok. */
  function structured(id: string | null, cmd: string | null, exitCode: unknown, aggregated: string): void {
    if (typeof exitCode !== 'number' || !Number.isInteger(exitCode)) return;
    const runKey = (match: (r: Running) => boolean) => Object.keys(m.running).find((k) => match(m.running[k]!));
    if (id && m.calls[id]?.shell) {
      m.exits[id] = exitCode;
      trim(m.exits, MAX_OPEN);
      return;
    }
    const byId = id ? runKey((r) => r.id === id) : undefined;
    if (byId !== undefined) return closeRunning(byId, exitCode, aggregated && !m.running[byId]!.head ? aggregated : '');
    if (!cmd) return;
    // By command only when exactly one open call (or running command) on this turn ran it: two `npm test` calls at
    // once would otherwise give one's exit to the other, a failure read as a pass (review).
    const same = Object.keys(m.calls).filter((k) => m.calls[k]!.shell && m.calls[k]!.cmd === cmd && m.calls[k]!.turn === m.turn && m.exits[k] === undefined);
    const byCmd = Object.keys(m.running).filter((k) => m.running[k]!.cmd === cmd && m.running[k]!.turn === m.turn);
    if (same.length + byCmd.length !== 1) return;
    if (same.length) {
      m.exits[same[0]!] = exitCode;
      return;
    }
    closeRunning(byCmd[0]!, exitCode, '');
  }
}

/**
 * The events of one parsed rollout line, for a caller that walks lines itself (the save gate's tail, a typed line
 * at an offset). `memo` carries open calls from line to line: start it as `{}`. A typed event here is only a
 * candidate: the dialect's `typedByPerson` judges it (P30). Never throws.
 */
export function codexLineEvents(entry: unknown, memo: CodexMemo, offset?: number, _env: NodeJS.ProcessEnv = process.env): TraceEvent[] {
  const out: TraceEvent[] = [];
  try {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return out;
    eventsOf(entry as Record<string, unknown>, memo, out, offset);
  } catch {
    /* a line of an unknown shape gives what it gave */
  }
  return out;
}

export interface CodexReadOptions extends EventReadOptions {
  /** The session state whose `codex.typedShas` decide which typed lines are the person's (P30). None: nothing is typed. */
  state?: SkillSessionState | null;
}

/**
 * The events a Codex rollout gained since the last call with the same `cursorPath` (1a's cursor: positioned,
 * 4 MB chunks). `.jsonl` only (P40), never an imported rollout (P39) or a forked one (D133), lines over 2 MB skipped.
 * Never throws.
 */
export function readNewCodexEvents(rolloutPath: string, cursorPath: string, opts: CodexReadOptions = {}): TraceEvent[] {
  const out: TraceEvent[] = [];
  const env = opts.env ?? process.env;
  try {
    if (!rolloutPath.endsWith('.jsonl') || isImportedRollout(rolloutPath, env) || isForkedRollout(rolloutPath)) return out;
    readAppended(rolloutPath, cursorPath, (line, memo, offset) => {
      if (line.length > MAX_LINE) return;
      let e: unknown;
      try {
        e = JSON.parse(line);
      } catch {
        return;
      }
      if (!e || typeof e !== 'object' || Array.isArray(e)) return;
      if (opts.onEntry) opts.onEntry(e as Record<string, unknown>, memo);
      eventsOf(e as Record<string, unknown>, memo, out, offset);
    }, opts);
  } catch {
    /* fail open */
  }
  return out.map((ev) => (ev.kind === 'typed' && !codexTypedByPerson(ev.text, opts.state, env) ? { ...ev, kind: 'injected' as const } : ev));
}
