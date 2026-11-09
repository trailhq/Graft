/**
 * Codex sessions for the hook journeys (phase 2 c7): the journey box of claude-skills-journey-fixtures.ts with a
 * Codex home, a rollout that grows as Codex writes it (`session_meta` first, exec calls and their outputs with the
 * `Process exited with code N` header), and Codex's hook payloads (`turn_id`, `model`, PostToolUse on every exit
 * with `tool_response` a plain string). Made-up repo, prompts and output only. Not a test file itself.
 *
 * The prompt hook records a Codex prompt's keyed hash itself (c8, 3.2 step 1, P30), so `cxPrompt` only writes the
 * rollout's lines and runs the hook.
 */
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CWD, hook, one, type Box, type Session } from './claude-skills-journey-fixtures.js';

let n = 0;
export interface CxSession extends Session { calls: number; turn: number }

const line = (iso: string, type: string, payload: Record<string, unknown>) => ({ timestamp: iso, type, payload });
const grow = (s: Session, lines: object[]) => appendFileSync(s.tx, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');

/** Unified exec's output text with its header, as Codex hands it to the model and to PostToolUse. */
export const execText = (code: number, body: string) => `Chunk ID: 4f2a9c\nWall time: 0.4120 seconds\nProcess exited with code ${code}\nOriginal token count: 12\nOutput:\n${body}`;
export const runningText = (id: number, body: string) => `Chunk ID: 7b1e3d\nWall time: 10.0011 seconds\nProcess running with session ID ${id}\nOriginal token count: 9\nOutput:\n${body}`;

/** A new Codex session in the shop checkout: its rollout under CODEX_HOME/sessions, the box's env pointed there. */
export function cxSession(b: Box, opts: { mode?: string; originator?: string; source?: string; payload?: Record<string, unknown> } = {}): CxSession {
  const sid = `019fa295-20a9-7943-90ae-${String(++n).padStart(12, '0')}`;
  const dir = join(b.home, '.codex', 'sessions', '2026', '10', '27');
  mkdirSync(dir, { recursive: true });
  const tx = join(dir, `rollout-2026-10-27T10-00-00-${sid}.jsonl`);
  const meta = {
    id: sid, session_id: sid, timestamp: '2026-10-01T00:00:00.000Z', cwd: b.repo, originator: opts.originator ?? 'codex_cli_rs', cli_version: '0.150.0-alpha.8',
    source: opts.source ?? 'cli', model_provider: 'openai', history_mode: 'legacy', git: { branch: 'main', repository_url: 'git@github.com:acme/shop.git' },
  };
  writeFileSync(tx, JSON.stringify(line('2026-10-01T00:00:00.000Z', 'session_meta', meta)) + '\n');
  b.env.CODEX_HOME = join(b.home, '.codex');
  // Codex sets no Claude Code entrypoint.
  b.env.CLAUDE_CODE_ENTRYPOINT = '';
  const mode = opts.mode ?? 'default';
  const payload = { session_id: sid, transcript_path: tx, cwd: CWD, permission_mode: mode, model: 'gpt-5-codex', turn_id: 'turn-1', ...opts.payload };
  return { b, sid, tx, mode, payload, calls: 0, turn: 0 };
}

/** The person's prompt: the rollout's lines (Codex writes them before the hook runs), then UserPromptSubmit. */
export async function cxPrompt(s: CxSession, iso: string, text: string): Promise<string> {
  const turn = `turn-${++s.turn}`;
  s.payload.turn_id = turn;
  grow(s, [
    line(iso, 'turn_context', { turn_id: turn, cwd: s.b.repo, approval_policy: 'on-request', sandbox_policy: { type: 'workspace-write' }, model: 'gpt-5-codex' }),
    line(iso, 'event_msg', { type: 'task_started', turn_id: turn, started_at: 1 }),
    line(iso, 'event_msg', { type: 'user_message', message: text, images: [], local_images: [], text_elements: [] }),
    line(iso, 'response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text }] }),
  ]);
  return hook(s, 'prompt', { hook_event_name: 'UserPromptSubmit', prompt: text }, iso);
}

export const cxStart = (s: CxSession, iso: string, source = 'startup') =>
  hook(s, 'session-start', { hook_event_name: 'SessionStart', source, turn_id: undefined }, iso);

export function cxReply(s: CxSession, iso: string, text: string): void {
  grow(s, [line(iso, 'event_msg', { type: 'agent_message', message: text, phase: null }), line(iso, 'response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] })]);
}

export const cxStop = (s: CxSession, iso: string, last: string | null, active = false) =>
  hook(s, 'stop', { hook_event_name: 'Stop', stop_hook_active: active, last_assistant_message: last }, iso);

export const cxPreBash = (s: CxSession, iso: string, command: string, id: string, extra: Record<string, unknown> = {}) =>
  hook(s, 'pre-bash', { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, tool_use_id: id, ...extra }, iso);

export const cxPostBash = (s: CxSession, iso: string, command: string, id: string, response: unknown) =>
  hook(s, 'codex-post-bash', { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command }, tool_use_id: id, tool_response: response }, iso);

export const nextCall = (s: CxSession) => `call_${s.sid.slice(-4)}${String(++s.calls).padStart(4, '0')}`;
export const cxCall = (s: CxSession, iso: string, id: string, command: string) =>
  grow(s, [line(iso, 'response_item', { type: 'function_call', name: 'exec_command', arguments: JSON.stringify({ cmd: command, workdir: s.b.repo, yield_time_ms: 10000 }), call_id: id })]);
export const cxOutput = (s: CxSession, iso: string, id: string, text: string) =>
  grow(s, [line(iso, 'response_item', { type: 'function_call_output', call_id: id, output: text })]);

/**
 * The agent runs `command` as Codex does it: the call in the rollout, PreToolUse, then (when let through) the
 * output in the rollout and PostToolUse with the same text, whatever the exit. A deny's reason is what the model
 * gets back as the call's output.
 */
export async function cxRuns(s: CxSession, iso: string, command: string, run: () => { out: string; code?: number } = () => ({ out: '' })): Promise<{ id: string; decision: Record<string, any> | null; post: string }> {
  const id = nextCall(s);
  cxCall(s, iso, id, command);
  const decision = one(await cxPreBash(s, iso, command, id));
  if (decision?.hookSpecificOutput?.permissionDecision === 'deny') {
    cxOutput(s, iso, id, decision.hookSpecificOutput.permissionDecisionReason);
    return { id, decision, post: '' };
  }
  const r = run();
  const text = execText(r.code ?? 0, r.out);
  cxOutput(s, iso, id, text);
  return { id, decision, post: await cxPostBash(s, iso, command, id, text) };
}
