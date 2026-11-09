/**
 * Reading a `trail skills add` command (design 4.9 step 1), whatever runs it:
 * `trail`, `graft`, `npx @trailhq/trail-code`, `node .../trail.js`,
 * `bash -c "..."`, `eval`, an alias or xargs. `skills add` anywhere in the
 * command is an add; it must read as exactly `skills add <name> --run <id>`,
 * once. Re-exported from `save-gate.ts`, where the design names it.
 *
 * Phase 2 (4.11): `trail skills update <name> --offer <id>`, read stricter
 * still: nothing chained and no root options, since its gate writes a file.
 */

import { leadingCds, onlyTrail, simpleCommands } from '../trace/shell.js';

export interface SkillsAddCmd { name: string; runId: string; flags: string[] }

/** /\bskills\s+add\b/: anywhere in the command, whatever binary, wrapper or path runs it. */
export const SKILLS_ADD_RE = /\bskills\s+add\b/;
const ALL_ADDS = /\bskills\s+add\b/g;
/** Where the add's own words end, outside quotes: the next command, a redirect, a comment, a subshell's end. */
const STOP = new Set([';', '&', '|', ')', '<', '>', '\n', '\r', '`']);

/** The words after `skills add`, up to the end of that command. A quote never closed ends it (the close of `bash -c "..."`). */
function tailWords(tail: string): string[] {
  const out: string[] = [];
  let cur = '';
  let has = false;
  const flush = () => {
    if (has) out.push(cur);
    cur = '';
    has = false;
  };
  for (let i = 0; i < tail.length; i++) {
    const ch = tail[i]!;
    if (ch === '"' || ch === "'") {
      const end = tail.indexOf(ch, i + 1);
      if (end < 0) break;
      cur += tail.slice(i + 1, end);
      has = true;
      i = end;
      continue;
    }
    if (ch === '\\' && i + 1 < tail.length && tail[i + 1] !== '\n') {
      cur += tail[i + 1];
      has = true;
      i++;
      continue;
    }
    if (STOP.has(ch)) {
      // `2>&1`: digits right before a redirect are the redirect's, not a word.
      if ((ch === '>' || ch === '<') && /^\d+$/.test(cur)) has = false;
      break;
    }
    if (ch === '#' && !has) break;
    if (ch === ' ' || ch === '\t') {
      flush();
      continue;
    }
    cur += ch;
    has = true;
  }
  flush();
  return out;
}

/** null when the command doesn't parse as `<anything> skills add <name> --run <id>`, or adds more than once. */
export function parseSkillsAdd(command: string): SkillsAddCmd | null {
  const text = String(command ?? '');
  const hits = [...text.matchAll(ALL_ADDS)];
  if (hits.length !== 1) return null;
  const words = tailWords(text.slice(hits[0]!.index! + hits[0]![0].length));
  let name: string | null = null;
  let runId: string | null = null;
  const flags: string[] = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!;
    if (w === '--run' && runId === null && i + 1 < words.length) {
      runId = words[++i]!;
      continue;
    }
    if (w.startsWith('--run=') && runId === null) {
      runId = w.slice(6);
      continue;
    }
    if (!w.startsWith('-') && name === null) {
      name = w;
      continue;
    }
    flags.push(w);
  }
  if (name === null || runId === null || !runId) return null;
  return { name, runId, flags };
}

/* 1b (4.15): `trail skills lesson [<skill>] --offer <offer-id>`, read the same way. */

export interface SkillsLessonCmd { skill: string | null; offerId: string; flags: string[] }

/** /\bskills\s+lesson\b/: anywhere in the command, whatever runs it (the lesson gate, R12's twin of SKILLS_ADD_RE). */
export const SKILLS_LESSON_RE = /\bskills\s+lesson\b/;
const ALL_LESSONS = /\bskills\s+lesson\b/g;
/** Every save the gate guards: a skill's add, a lesson's keep, and (phase 2) a skill's update. */
export const SAVE_GATE_RE = /\bskills\s+(?:add|lesson|update)\b/;

/** null when the command doesn't parse as `<anything> skills lesson [<skill>] --offer <id>`, or keeps more than one. */
export function parseSkillsLesson(command: string): SkillsLessonCmd | null {
  const text = String(command ?? '');
  const hits = [...text.matchAll(ALL_LESSONS)];
  if (hits.length !== 1 || [...text.matchAll(ALL_ADDS)].length) return null;
  const words = tailWords(text.slice(hits[0]!.index! + hits[0]![0].length));
  let skill: string | null = null;
  let offerId: string | null = null;
  const flags: string[] = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!;
    if (w === '--offer' && offerId === null && i + 1 < words.length) {
      offerId = words[++i]!;
      continue;
    }
    if (w.startsWith('--offer=') && offerId === null) {
      offerId = w.slice(8);
      continue;
    }
    if (!w.startsWith('-') && skill === null && offerId === null) {
      skill = w;
      continue;
    }
    flags.push(w);
  }
  if (!offerId) return null;
  return { skill, offerId, flags };
}

/* Phase 2 (4.11 step 2, R25): `trail skills update <name> --offer <o-id>`. */

export interface SkillsUpdateCmd { name: string; offerId: string }

/** /\bskills\s+update\b/: anywhere in the command, whatever runs it. */
export const SKILLS_UPDATE_RE = /\bskills\s+update\b/;
const ALL_UPDATES = /\bskills\s+update\b/g;
/** Past this the command is not read (D89). */
const UPDATE_MAX = 64 * 1024;
/** What comes right before `skills update`: a Trail binary, nothing between it and `skills` (no root option). */
const TRAIL_BIN = /(?:^|[\s/"'(])(?:trail|graft|trail-code|@trailhq\/trail-code|@nanonets\/graft|(?:trail|graft)\.js)\s+$/;
const SKILL_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
const OFFER_ID = /^o-[0-9a-f]{6}$/;
/** A pipe (not `||`): its other side could cut or rewrite what the update prints. */
const PIPE = /(?:^|[^|])\|(?!\|)/;

/**
 * null unless the command is exactly one `<trail> skills update <name> --offer <o-id>`, Trail's own and nothing
 * else (1a's `onlyTrail`, one simple command after any leading cds, no pipe), with no other add, lesson or update.
 */
export function parseSkillsUpdate(command: string): SkillsUpdateCmd | null {
  const text = String(command ?? '');
  if (text.length > UPDATE_MAX) return null;
  const hits = [...text.matchAll(ALL_UPDATES)];
  if (hits.length !== 1 || SKILLS_ADD_RE.test(text) || SKILLS_LESSON_RE.test(text)) return null;
  if (!TRAIL_BIN.test(text.slice(Math.max(0, hits[0]!.index! - 200), hits[0]!.index!))) return null;
  if (PIPE.test(text) || !onlyTrail(text) || simpleCommands(leadingCds(text).rest).length !== 1) return null;
  const words = tailWords(text.slice(hits[0]!.index! + hits[0]![0].length));
  let name: string | null = null;
  let offerId: string | null = null;
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!;
    if (w === '--offer' && offerId === null && i + 1 < words.length) offerId = words[++i]!;
    else if (w.startsWith('--offer=') && offerId === null) offerId = w.slice(8);
    else if (!w.startsWith('-') && name === null) name = w;
    else return null;
  }
  if (!name || !offerId || !SKILL_NAME.test(name) || !OFFER_ID.test(offerId)) return null;
  return { name, offerId };
}
