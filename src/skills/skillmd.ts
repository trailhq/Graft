/**
 * A learned skill's SKILL.md (design 2.1, spec 6), written and read.
 *
 * Only `name` and `description` sit at the top level; everything of Trail's
 * is under `metadata` as flat quoted strings, and `metadata.trail` is the one
 * mark that makes a file Trail's. Sections are always Run, Check it worked,
 * If it fails, Don't use for.
 *
 * Every value is written on one line: text a person or an agent wrote (a
 * repo name, an error line) can't open a line of its own, so it can't start
 * a `[trail]` line, a heading or a step. Reading goes through phase 0's
 * guarded front-matter reader (no anchors, aliases or code fences), and a
 * file without `metadata.trail` is never read for steps: Trail never reads
 * or edits another skill's steps.
 */
import { createHash } from 'node:crypto';
import type { GatedKind, JobClass } from '../trace/types.js';
import type { CompiledSkill, ParsedSkill, Scope, SkillMeta, SkillStep } from './types.js';
import { flatLine } from '../notes/flatten.js';
import { matter } from '../util/front-matter.js';
import { gatedKind } from './risk.js';
import { metaToParams } from './params.js';

export const GATED_PREFIX = "Can't be undone (Claude Code asks the person first): ";
export const WAIT_NOTE = '(a wait: run it in the background if it may take over 2 minutes)';
export const BG_NOTE = '(in the background)';
export const NO_CHECK = 'No check ran in the run this came from.';
export const NOTHING_FAILED = 'Nothing failed in the run this came from.';
/** D59b: a check read with a deploy status tool (`check-tool`), not run as a command. */
export const TOOL_CHECK = 'Check the deployment the same way the run did: ';

const META_ORDER: ReadonlyArray<keyof SkillMeta> = [
  'trail', 'scope', 'applies', 'job', 'asks', 'status-asks', 'params', 'needs', 'ready', 'check-first', 'before-you-start', 'confirm-before', 'check', 'check-shows', 'check-tool', 'version',
];
/** Values that are commands or command lists: kept as typed, only made one line. */
const COMMAND_KEYS = new Set<string>(['params', 'needs', 'ready', 'check-first', 'confirm-before', 'check']);

const BREAKS = /\r\n|[\n\r\u000b\u000c\u0085\u2028\u2029]/g;
const HIDDEN = /[\p{Cf}\ufe00-\ufe0f\u{e0100}-\u{e01ef}\u0000-\u0008\u000e-\u001f\u007f-\u0084\u0086-\u009f]/gu;
const MARKER = /^\s*(?:\[(?:trail|graft|trail-code)\]\s*)+/i;

/** A command on one line: breaks become spaces, hidden characters go; spaces inside it are kept. */
export function oneLine(text: string): string {
  return String(text ?? '').replace(HIDDEN, '').replace(BREAKS, ' ').replace(/\t/g, ' ').replace(MARKER, '').trim();
}
/** Prose on one line; three dashes in a row would end the front matter for some readers. */
const prose = (text: unknown, max = 1024) => flatLine(text, max).replace(/-{3,}/g, '--');

/**
 * A command as a double-quoted YAML string. Three dashes in a row end the front matter for some readers,
 * so a dash inside such a run is written `\u002d`, which YAML reads back as `-`: the command stays as typed.
 */
const quoted = (cmd: string) => JSON.stringify(cmd).replace(/-{3,}/g, (m) => `-${'\\u002d'.repeat(m.length - 2)}-`);

/** The step in a code span whose fence is longer than any backtick run inside it. */
function codeSpan(cmd: string): string {
  const longest = Math.max(0, ...[...cmd.matchAll(/`+/g)].map((m) => m[0].length));
  if (!longest) return `\`${cmd}\``;
  const fence = '`'.repeat(longest + 1);
  return `${fence} ${cmd} ${fence}`;
}

export function renderSkillMd(c: CompiledSkill): string {
  const meta = c.meta as unknown as Record<string, string | undefined>;
  const keys = [...META_ORDER, ...Object.keys(meta).filter((k) => !(META_ORDER as readonly string[]).includes(k))];
  const front = ['---', `name: ${c.name}`, `description: ${JSON.stringify(prose(c.description))}`, 'metadata:'];
  for (const k of keys) {
    const v = meta[k];
    if (v === undefined || v === null || String(v) === '') continue;
    front.push(`  ${k}: ${COMMAND_KEYS.has(k) ? quoted(oneLine(String(v))) : JSON.stringify(prose(v))}`);
  }
  front.push('---');

  const run = c.steps.map((s) => {
    const note = s.wait ? ` ${WAIT_NOTE}` : s.bg ? ` ${BG_NOTE}` : '';
    return `${s.n}. ${s.gated ? GATED_PREFIX : ''}${codeSpan(oneLine(s.cmd))}${note}`;
  });

  let check: string;
  const shows = c.checkShows ? prose(c.checkShows, 200) : '';
  const phrase = /\s/.test(shows);
  if (!c.check) check = NO_CHECK;
  else if (c.meta['check-tool']) check = `${TOOL_CHECK}${prose(c.check, 300)}${shows ? `; it shows ${shows}` : ''}.`;
  else if (c.checkIsStep) {
    const n = [...c.steps].reverse().find((s) => s.cmd === c.check)?.n;
    const lead = n ? `Step ${n}, ${codeSpan(oneLine(c.check))}, is the check` : `${codeSpan(oneLine(c.check))} is the check`;
    check = shows ? `${lead}: ${shows}.` : `${lead}.`;
  } else if (!shows) check = `${codeSpan(oneLine(c.check))} works.`;
  else check = `${codeSpan(oneLine(c.check))} shows ${phrase ? shows : codeSpan(shows)}.`;

  const fails = c.ifFails.map((l) => prose(l, 200)).filter(Boolean);
  const before = beforeYouStart(c.meta);
  return [
    ...front,
    `# ${prose(c.title, 160)}`,
    '',
    ...(before.length ? ['## Before you start', ...before.map((l) => `- ${l}`), ''] : []),
    '## Run',
    ...run,
    '',
    '## Check it worked',
    check,
    '',
    '## If it fails',
    ...(fails.length ? fails.map((l) => `- ${l}`) : [NOTHING_FAILED]),
    '',
    "## Don't use for",
    prose(c.dontUse, 300),
    '',
  ].join('\n');
}

/** D116 item 5: the lines of `metadata.before-you-start`, each one flat line. */
export function beforeYouStart(meta: Pick<SkillMeta, 'before-you-start'>): string[] {
  return String(meta['before-you-start'] ?? '').split(' | ').map((l) => prose(l, 200)).filter(Boolean).slice(0, 3);
}

export function skillHash(text: string): string {
  return `sha256:${createHash('sha256').update(String(text ?? '')).digest('hex')}`;
}

/** The command in a Run line's first code span, and what follows it (CommonMark code spans). */
function readSpan(rest: string): { cmd: string; after: string } | null {
  const open = /`+/.exec(rest);
  if (!open) return null;
  const len = open[0].length;
  const from = open.index + len;
  const close = new RegExp(`(?<!\`)\`{${len}}(?!\`)`, 'g');
  close.lastIndex = from;
  const m = close.exec(rest);
  if (!m) return null;
  let cmd = rest.slice(from, m.index);
  if (cmd.length > 1 && cmd.startsWith(' ') && cmd.endsWith(' ') && cmd.trim()) cmd = cmd.slice(1, -1);
  return { cmd, after: rest.slice(m.index + len) };
}

const isMap = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v) && !(v instanceof Date);
const SCOPES = new Set<Scope>(['personal', 'repo', 'team']);
const JOBS = new Set<JobClass>(['release', 'ship', 'pr-green', 'sweep', 'run-local', 'report', 'tests']);
const section = (heading: string) => heading.toLowerCase().replace(/[\u2019']/g, "'").replace(/\s+/g, ' ').trim();

/** Through phase 0's matter(): null on `refused` (anchors, aliases, non-scalars) or when there is no `metadata.trail` key. */
export function parseSkillMd(text: string, folderName: string): ParsedSkill | null {
  const src = String(text ?? '');
  let fm;
  try {
    fm = matter(src, { scalars: ['name', 'description'] });
  } catch {
    return null;
  }
  if (fm.refused) return null;
  const data = fm.data as Record<string, unknown>;
  const raw = data.metadata;
  if (!isMap(raw)) return null;
  const strings: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (v === null || v === undefined) continue;
    if (typeof v === 'object' && !(v instanceof Date)) return null;
    strings[k] = v instanceof Date ? v.toISOString().slice(0, 10) : String(v);
  }
  if (!strings.trail?.trim()) return null;

  const meta: Record<string, string> = {};
  for (const k of [...META_ORDER, ...Object.keys(strings)]) if (strings[k] !== undefined && meta[k] === undefined) meta[k] = strings[k]!;
  if (!SCOPES.has(meta.scope as Scope)) meta.scope = 'personal';
  if (meta.job !== undefined && !JOBS.has(meta.job as JobClass)) delete meta.job;
  meta.asks ??= '';
  meta.version ??= '1';

  const confirm = new Set((meta['confirm-before'] ?? '').split(' ; ').map((s) => s.trim()).filter(Boolean));
  const steps: SkillStep[] = [];
  const ifFails: string[] = [];
  const dontUse: string[] = [];
  let where = '';
  for (const line of String(fm.content ?? '').split(/\r?\n/)) {
    const h = /^##\s+(.+?)\s*#*\s*$/.exec(line);
    if (h) { where = section(h[1]!); continue; }
    if (where === 'run') {
      const m = /^\s*\d+\.\s+(.*)$/.exec(line);
      if (!m) continue;
      let rest = m[1]!;
      const prefixed = /^can[\u2019']t be undone\b[^`]*?:\s*/i.exec(rest);
      if (prefixed) rest = rest.slice(prefixed[0].length);
      const span = readSpan(rest);
      if (!span || !span.cmd.trim()) continue;
      const cmd = span.cmd;
      const kind: GatedKind | null = gatedKind(cmd);
      const gated = kind ?? (prefixed || confirm.has(cmd) ? 'deploy' : null);
      steps.push({ n: steps.length + 1, cmd, gated, bg: /\(in the background\)/i.test(span.after), wait: /\(a wait\b/i.test(span.after) });
    } else if (where === 'if it fails') {
      const m = /^\s*[-*]\s+(.+)$/.exec(line);
      if (m) ifFails.push(m[1]!.trim());
    } else if (where === "don't use for" && line.trim()) dontUse.push(line.trim());
  }

  return {
    name: typeof data.name === 'string' && data.name.trim() ? data.name : folderName,
    description: typeof data.description === 'string' ? data.description : '',
    meta: meta as unknown as SkillMeta,
    steps,
    check: meta.check?.trim() ? meta.check : null,
    checkShows: meta['check-shows']?.trim() ? meta['check-shows'] : null,
    ifFails,
    dontUse: dontUse.join(' '),
    params: metaToParams(meta.params),
    hash: skillHash(src),
  };
}
