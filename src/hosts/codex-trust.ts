/**
 * Whether Codex trusts Trail's hook entries (design 4.17, HC8), read only, and
 * the words Trail says about Codex (`CODEX_COPY`).
 *
 * Codex runs a non-managed hook only when `config.toml` holds a trust record
 * for it whose hash matches the entry: `[hooks.state."<key>"]` with a
 * `trusted_hash`, where the key is the hooks.json path, the event's label
 * (`pre_tool_use`, ...), the group's index and the handler's index (the
 * open-source Codex's `hook_key`; HC8 confirms it on the installed build). The
 * person makes that record in Codex's `/hooks`. Trail never writes it, never
 * passes a flag that skips it (rule 8), and never guesses: a form it doesn't
 * know reads as `unknown`.
 *
 * `trusted` means every Trail entry has a trust record that is on; the hash in
 * it is not recomputed here (Codex's own identity hash), so an entry changed
 * since it was trusted would still read as trusted. Trail's entries are
 * byte-stable from 0.26.0 on (P33), which is when that can happen once (D125).
 */
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { codexHome } from '../trace/codex.js';
import { CODEX_TIER } from '../trace/host.js';
import { hostTier } from '../skills/host-facts.js';
import type { HookOut } from '../skills/types.js';

/** The words Trail says about Codex. Each is checked by the words test. */
export const CODEX_COPY: Readonly<Record<'trust' | 'sandbox' | 'notTierA' | 'ephemeral', string>> = Object.freeze({
  trust: "Codex runs Trail's hooks only after you trust them: in Codex, type /hooks and trust the Trail entries (graft-hooks.cjs).",
  sandbox: 'Trail keeps skills in ~/.trail, outside this folder, so Codex may ask the person to let this command write there.',
  notTierA: "Trail brings back your skills in Codex, but it doesn't offer to keep new ones there yet: its checks of Codex aren't done.",
  ephemeral: "This Codex session isn't kept on disk, so Trail only brings back skills here and keeps nothing new from it.",
});

/** A `trail skills` command that writes to ~/.trail, which Codex runs inside its sandbox (4.17). */
const WRITES_TRAIL = /\btrail skills (?:add|lesson|update)\b/;

/**
 * P36: on Codex, a directive or Stop reason that names a command writing to ~/.trail also says the sandbox may ask
 * the person first, so a sandbox prompt or refusal is no surprise. Once, at the end; other hosts and other text as
 * they are.
 */
export function withCodexSandbox(out: HookOut, host: string): HookOut {
  if (host !== 'codex') return out;
  const add = (t: string | undefined) => (t && WRITES_TRAIL.test(t) && !t.includes(CODEX_COPY.sandbox) ? `${t} ${CODEX_COPY.sandbox}` : t);
  const next: HookOut = { ...out };
  if (out.context !== undefined) next.context = add(out.context);
  if (out.block !== undefined) next.block = add(out.block);
  return next;
}

/** Codex's event names to the labels its trust keys use (`hook_event_key_label`). */
const LABELS: Readonly<Record<string, string>> = Object.freeze({
  PreToolUse: 'pre_tool_use', PermissionRequest: 'permission_request', PostToolUse: 'post_tool_use', PreCompact: 'pre_compact',
  PostCompact: 'post_compact', SessionStart: 'session_start', SessionEnd: 'session_end', UserPromptSubmit: 'user_prompt_submit',
  SubagentStart: 'subagent_start', SubagentStop: 'subagent_stop', Stop: 'stop', Interrupt: 'interrupt',
});

const TRAIL_SHIM = /(?:graft|trail)-hooks\.cjs/;
const MAX_BYTES = 1024 * 1024;

function readSmall(path: string): string | null {
  try {
    const st = statSync(path);
    if (!st.isFile() || st.size > MAX_BYTES) return null;
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

/** The trust key of every Trail handler in CODEX_HOME/hooks.json, in file order; null when it can't be read. */
function keysOf(env: NodeJS.ProcessEnv): { path: string; keys: string[] } | null {
  const path = join(codexHome(env), 'hooks.json');
  const text = readSmall(path);
  if (text === null) return null;
  let root: unknown;
  try {
    root = JSON.parse(text);
  } catch {
    return null;
  }
  const hooks = root && typeof root === 'object' ? (root as { hooks?: unknown }).hooks : undefined;
  if (!hooks || typeof hooks !== 'object' || Array.isArray(hooks)) return null;
  const keys: string[] = [];
  for (const [event, groups] of Object.entries(hooks as Record<string, unknown>)) {
    const label = LABELS[event];
    if (!label || !Array.isArray(groups)) continue;
    groups.forEach((g, gi) => {
      const handlers = g && typeof g === 'object' ? (g as { hooks?: unknown }).hooks : undefined;
      if (!Array.isArray(handlers)) return;
      handlers.forEach((h, hi) => {
        const c = h && typeof h === 'object' ? (h as { command?: unknown }).command : undefined;
        if (typeof c === 'string' && TRAIL_SHIM.test(c)) keys.push(`${path}:${label}:${gi}:${hi}`);
      });
    });
  }
  return { path, keys };
}

/** Trail's trust keys as Codex forms them for this CODEX_HOME (for the lab's HC8 and the tests). */
export function trailHookKeys(env: NodeJS.ProcessEnv = process.env): string[] {
  return keysOf(env)?.keys ?? [];
}

/** A TOML basic or literal string at the start of `s`: its value and the rest, or null. */
function tomlString(s: string): { value: string; rest: string } | null {
  if (s.startsWith("'")) {
    const end = s.indexOf("'", 1);
    return end < 0 ? null : { value: s.slice(1, end), rest: s.slice(end + 1) };
  }
  if (!s.startsWith('"')) return null;
  let out = '';
  for (let i = 1; i < s.length; i++) {
    const ch = s[i]!;
    if (ch === '"') return { value: out, rest: s.slice(i + 1) };
    if (ch !== '\\') { out += ch; continue; }
    const nx = s[++i];
    if (nx === 'u' || nx === 'U') {
      const n = nx === 'u' ? 4 : 8;
      const hex = s.slice(i + 1, i + 1 + n);
      if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length !== n) return null;
      out += String.fromCodePoint(parseInt(hex, 16));
      i += n;
      continue;
    }
    const esc: Record<string, string> = { '"': '"', '\\': '\\', n: '\n', t: '\t', r: '\r', b: '\b', f: '\f' };
    if (nx === undefined || !(nx in esc)) return null;
    out += esc[nx];
  }
  return null;
}

interface Record_ { hash: string | null; enabled: boolean | null }
interface Parsed { records: Map<string, Record_>; unplaced: boolean }

/** `trusted_hash = "..."` and `enabled = true|false` in `body` (a table's lines or an inline table's inside). */
function fields(body: string, rec: Record_): boolean {
  let ok = true;
  for (const m of body.matchAll(/\b(trusted_hash|enabled)\s*=\s*([^,}\n]*)/g)) {
    const v = m[2]!.trim();
    if (m[1] === 'trusted_hash') {
      const s = tomlString(v);
      if (s) rec.hash = s.value;
      else ok = false;
    } else if (v === 'true' || v === 'false') rec.enabled = v === 'true';
    else ok = false;
  }
  return ok;
}

/** The `[hooks.state]` records in config.toml, in both forms Codex's writer may use. */
function parseState(text: string): Parsed {
  const records = new Map<string, Record_>();
  let unplaced = false;
  let current: Record_ | null = null;
  let inState = false;
  // A multi-line string's lines are its text, never tables or keys (a `[hooks.state...]` line in a prompt included).
  let ml: string | null = null;
  for (const raw of text.split(/\r?\n/)) {
    if (ml) {
      if (raw.includes(ml)) ml = null;
      continue;
    }
    ml = ['"""', "'''"].find((q) => (raw.split(q).length - 1) % 2 === 1) ?? null;
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('[')) {
      current = null;
      inState = false;
      const sub = /^\[\s*hooks\.state\.(.+)\]\s*(?:#.*)?$/.exec(line);
      if (sub) {
        const key = tomlString(sub[1]!.trim());
        if (key && key.rest.trim() === '') {
          current = records.get(key.value) ?? { hash: null, enabled: null };
          records.set(key.value, current);
        } else unplaced = true;
      } else if (/^\[\s*hooks\.state\s*\]/.test(line)) inState = true;
      continue;
    }
    if (current) {
      if (!fields(line, current)) unplaced = true;
      continue;
    }
    if (inState) {
      const key = tomlString(line);
      const inline = key ? /^\s*=\s*\{(.*)\}\s*(?:#.*)?$/.exec(key.rest) : null;
      if (key && inline) {
        const rec = records.get(key.value) ?? { hash: null, enabled: null };
        records.set(key.value, rec);
        if (!fields(inline[1]!, rec)) unplaced = true;
      } else if (/trusted_hash|enabled/.test(line)) unplaced = true;
      continue;
    }
    if (/trusted_hash/.test(line)) unplaced = true;
  }
  return { records, unplaced };
}

/** A key in the form Trail knows: `<path>:<label>:<group>:<handler>`. */
const KEY_FORM = new RegExp(`:(?:${Object.values(LABELS).join('|')}):\\d+:\\d+$`);

/**
 * Whether Codex will run Trail's hook entries (HC8), from CODEX_HOME's hooks.json and config.toml, read only.
 * `untrusted` lists the trust keys of Trail's entries with no record, no hash, or turned off.
 */
export function codexTrust(env: NodeJS.ProcessEnv = process.env): { state: 'trusted' | 'untrusted' | 'unknown'; untrusted: string[] } {
  const unknown = { state: 'unknown' as const, untrusted: [] };
  try {
    const found = keysOf(env);
    if (!found || !found.keys.length) return unknown;
    const cfgPath = join(codexHome(env), 'config.toml');
    let text = '';
    try {
      statSync(cfgPath);
      const t = readSmall(cfgPath);
      if (t === null) return unknown;
      text = t;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') return unknown;
    }
    const parsed = parseState(text);
    if (parsed.unplaced) return unknown;
    const keys = [...parsed.records.keys()];
    if (keys.some((k) => !KEY_FORM.test(k))) return unknown;
    const untrusted = found.keys.filter((k) => {
      const r = parsed.records.get(k);
      return !r || !r.hash || r.enabled === false;
    });
    return { state: untrusted.length ? 'untrusted' : 'trusted', untrusted };
  } catch {
    return unknown;
  }
}

/** For `trail init` and `trail status` (c8): the trust line, when Codex is here with Trail's entries and they aren't sure to be trusted. */
export function codexTrustLine(env: NodeJS.ProcessEnv = process.env): string | null {
  if (!trailHookKeys(env).length) return null;
  return codexTrust(env).state === 'trusted' ? null : CODEX_COPY.trust;
}

/**
 * `trail status` (c8, D137): with Trail's Codex hooks in place, the trust line until each entry is trusted, and while
 * Codex is tier B the line on why Trail only brings skills back there. Read only. The ephemeral line is a session's,
 * said at that session's start, never here.
 */
export function codexStatusLines(env: NodeJS.ProcessEnv = process.env): string[] {
  try {
    if (!trailHookKeys(env).length) return [];
    const trust = codexTrustLine(env);
    return [...(trust ? [trust] : []), ...(hostTier('codex', CODEX_TIER, env) === 'A' ? [] : [CODEX_COPY.notTierA])];
  } catch {
    return [];
  }
}
