/**
 * The text-level facts of a Codex tool call (design 4.15): which exit an
 * output's header names, the output's body without that header, the shell
 * line an argument vector stands for, and the files an apply_patch touches.
 * Codex keeps a command's exit only as text in the model-facing output
 * (`Process exited with code N`, or the older `Exit code: N`, or JSON
 * `metadata.exit_code`), so these readers look only at the header, never at
 * the body, where a command's own output could print the same words.
 * Pure: no disk, no clock.
 */
import { isAbsolute, resolve } from 'node:path';

/** Where the header ends: unified exec and the older shell both put `Output:` on a line of its own. */
const OUTPUT_LINE = /^Output:\s*$/m;
const EXITED = /^Process exited with code (-?\d+)\s*$/m;
const RUNNING = /^Process running with session ID (\d+)\s*$/m;
const EXIT_CODE = /^Exit code: (-?\d+)\s*$/m;

/** The text of a `function_call_output.output`: a string, or the text of an array of content parts. */
export function outputText(out: unknown): string {
  if (typeof out === 'string') return out;
  if (Array.isArray(out)) {
    return out.flatMap((p) => (p && typeof p === 'object' && typeof (p as { text?: unknown }).text === 'string' ? [(p as { text: string }).text] : [])).join('\n');
  }
  if (out && typeof out === 'object') {
    const o = out as { content?: unknown; body?: unknown };
    if (typeof o.content === 'string') return o.content;
    if (o.content !== undefined) return outputText(o.content);
  }
  return '';
}

function jsonOutput(text: string): { output: string; code: number | null } | null {
  const t = text.trimStart();
  if (!t.startsWith('{')) return null;
  try {
    const v = JSON.parse(t) as { output?: unknown; metadata?: { exit_code?: unknown } };
    if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
    const code = typeof v.metadata?.exit_code === 'number' && Number.isInteger(v.metadata.exit_code) ? v.metadata.exit_code : null;
    if (code === null && typeof v.output !== 'string') return null;
    return { output: typeof v.output === 'string' ? v.output : '', code };
  } catch {
    return null;
  }
}

/**
 * The header part of an output text: before its `Output:` line. Every exec output Codex writes has that line; a text
 * without one has no header at all, so a command that prints `Process exited with code 0` can't name its own exit
 * (review: its first lines were read as a header).
 */
function headerOf(text: string): { head: string; body: string } {
  const m = OUTPUT_LINE.exec(text);
  if (m) return { head: text.slice(0, m.index), body: text.slice(m.index + m[0].length).replace(/^\r?\n/, '') };
  return { head: '', body: text };
}

/** 4.15: the exit an output's header names, `{ running }` for a command still running, null when it names none. */
export function codexExitOf(output: string): { code: number } | { running: number } | null {
  if (typeof output !== 'string' || !output) return null;
  const j = jsonOutput(output);
  if (j) return j.code === null ? null : { code: j.code };
  const { head } = headerOf(output);
  const run = RUNNING.exec(head);
  if (run) return { running: Number(run[1]) };
  const m = EXITED.exec(head) ?? EXIT_CODE.exec(head);
  return m ? { code: Number(m[1]) } : null;
}

/** The output without its header: what the command printed. */
export function outputBody(output: string): string {
  const j = jsonOutput(output);
  if (j) return j.output;
  const { head, body } = headerOf(output);
  return EXITED.test(head) || EXIT_CODE.test(head) || RUNNING.test(head) ? body : output;
}

const SHELLS = /^(?:\/(?:usr\/)?(?:local\/)?bin\/)?(?:bash|zsh|sh|dash|ksh|fish)$/;
const SAFE_WORD = /^[A-Za-z0-9_@%+=:,./-]+$/;

/** One word as a shell would need it written. */
export function shellQuote(w: string): string {
  if (w !== '' && SAFE_WORD.test(w)) return w;
  return `'${w.replace(/'/g, `'\\''`)}'`;
}

/** The command an argument vector runs: `bash -lc X` and `sh -c X` read as X; any other vector joined with quoting. */
export function argvCommand(argv: unknown): string | null {
  if (!Array.isArray(argv) || !argv.length || !argv.every((w) => typeof w === 'string')) return null;
  const w = argv as string[];
  if (w.length === 3 && SHELLS.test(w[0]!) && /^-l?c$|^-cl$/.test(w[1]!)) return w[2]!;
  return w.map(shellQuote).join(' ');
}

const PATCH_FILE = /^\*\*\* (?:Add|Update|Delete) File: (.+)$|^\*\*\* Move to: (.+)$/gm;

/** The files an apply_patch body names, in order, each once. */
export function patchFiles(patch: unknown): string[] {
  if (typeof patch !== 'string') return [];
  const out: string[] = [];
  for (const m of patch.matchAll(PATCH_FILE)) {
    const f = (m[1] ?? m[2] ?? '').trim();
    if (f && !out.includes(f)) out.push(f);
    if (out.length >= 50) break;
  }
  return out;
}

/** apply_patch run as a command: Codex applies the patch itself (its shell handler reads these forms). */
const SHELL_PATCH = /(?:^|[\s;&|(])(?:apply_patch|applypatch)(?![\w-])/;
const PATCH_BEGIN = /(?:^|['"])\*\*\* Begin Patch\s*$/m;

/**
 * The files a shell command patches when it runs apply_patch (`apply_patch <<'EOF'`, `["apply_patch", patch]`, after
 * a `cd`), absolute against the folder it runs in when that is known. [] for any other command (review).
 */
export function shellPatchFiles(cmd: string, cwd: string | undefined): string[] {
  if (!SHELL_PATCH.test(cmd) || !PATCH_BEGIN.test(cmd)) return [];
  const cd = /^\s*cd\s+('[^']*'|"[^"]*"|[^\s;&|]+)\s*&&/.exec(cmd)?.[1]?.replace(/^(['"])(.*)\1$/, '$2');
  const base = cd ? (isAbsolute(cd) ? cd : cwd ? resolve(cwd, cd) : undefined) : cwd;
  return patchFiles(cmd).map((f) => (base && !isAbsolute(f) ? resolve(base, f) : f));
}
