/**
 * Bringing skills back (design 4.6, 4.7, spec 11): which skill, if any, a
 * typed prompt asks for, and the one line a session starts with.
 *
 * The cue matcher reads only the person's own words (`askText`: no pasted
 * code, quoted lines or very long lines) and picks at most one skill:
 *  - a name cue: the prompt names the skill;
 *  - a job cue: the prompt is the skill's job (its class of ask, or one of
 *    the asks it was saved with, word for word with at most one word between);
 *  - a check cue: a status question ("is it live?") about the skill used
 *    most recently here, answered with its check line only.
 * Any other status or history question, a problem report, or an ask of
 * more than 25 words matches nothing (up to 60 when it names the skill's
 * place and its job verb, D71 a). Only candidate and active skills in
 * scope are candidates: held items, retired, needs-fix and skills the person
 * turned off never are.
 *
 * Only the words go into the match; nothing typed is stored.
 */
import type { PromptParams } from '../trace/types.js';
import type { ParsedSkill, Scope, SkillRef, SkillState } from './types.js';
import { askText, JOB_CLASSES, PROBLEM_REPORT, promptParams, STATUS_OR_HISTORY, wordCount } from '../trace/jobs.js';
import { flatLine } from '../notes/flatten.js';
import { fillParams, resolveParams } from './params.js';
import { literalPassword, neverSave } from './never-save.js';
import { listSkills, readSkill, type ScopeCtx } from './store.js';
import { readSkillsState } from './state.js';
import { readLedger } from './ledger.js';
import { adoptIfCopied } from './versions.js';
import { phraseSha, unusedSince } from './staleness.js';
import { ANCHOR_COPY } from './anchors.js';

export interface NormPrompt { raw: string; words: string[]; content: string[]; params: PromptParams; status: boolean; problem: boolean; wordCount: number }
/**
 * 1b: `here` is where candidatesHere found it (the checkout and env), so the block can check its anchors at
 * injection (4.18); `phraseSha` is set on the candidate a job cue picked by one of its asks phrases (R30).
 */
export interface Candidate { ref: SkillRef; skill: ParsedSkill; state: SkillState | null; here?: { checkout: string; env?: NodeJS.ProcessEnv }; phraseSha?: string | null }
/** 1b: `phraseSha` is the asks phrase a job cue hit (8 hex, R30), null otherwise; the same value rides on `cand`. */
export interface CueResult { kind: 'job' | 'name' | 'check'; cand: Candidate; score: number; values: Record<string, string>; notes: string[]; phraseSha?: string | null }

const STOP = new Set(
  ("a an the to and then please can could would you we i it its this that now also just so okay ok yes lets let's do some me my our for of on in at "
    + 'first again too as well be is are will').split(' '),
);
/** Spellings of one word, as the asks are written (4.6). */
const CANON: Record<string, string> = { puch: 'push', psuh: 'push', 'fast-forward': 'ff', fastforward: 'ff', production: 'prod', publishing: 'publish' };
const URL = /\b[a-z][a-z0-9+.-]*:\/\/\S+/gi;
const VERSION_RE = /\bv?\d+\.\d+\.\d+(?:-[0-9a-z.]+)?\b/gi;
const PR_RE = /(?:^|\s)#\d+\b|\bpr\s*#?\d+\b|\/pull\/\d+/gi;
const MAX_WORDS = 25;
/** D71 a: an ask up to 60 words still cues a skill when it names one of the skill's places and its job verb. */
const LONG_MAX_WORDS = 60;
const DAY_MS = 24 * 60 * 60 * 1000;

const canon = (w: string) => CANON[w] ?? w;
/** Words of a lowercased text: split on anything but letters, digits, `{}#.-`; dots and dashes at a word's ends go. */
const split = (t: string) => t.split(/[^a-z0-9{}#.-]+/).map((w) => w.replace(/^[.-]+|[.-]+$/g, '')).filter(Boolean).map(canon);
const lower = (t: string) => t.toLowerCase().replace(/\bfast forward/g, 'fast-forward');

/** 4.6: the ask's words, its shape values as params and placeholders, its content words, and its kind. */
export function normalizePrompt(typed: string): NormPrompt {
  const raw = askText(String(typed ?? ''));
  const params = promptParams(raw);
  let t = lower(now(raw)).replace(URL, ' url ').replace(VERSION_RE, ' {version} ').replace(PR_RE, ' {pr} ');
  // "push the new version on npm": with npm, a push is a publish.
  if (/\bnpm\b/.test(t)) t = t.replace(/\b(?:push|puch|psuh)\w*/g, 'publish');
  if (params.sha) t = t.replace(new RegExp(`\\b${params.sha.toLowerCase()}\\b`, 'g'), ' {sha} ');
  const words = split(t);
  return {
    raw,
    words,
    content: words.filter((w) => !STOP.has(w) && !/^\{\w+\}$/.test(w)),
    params,
    status: STATUS_OR_HISTORY.test(raw),
    problem: PROBLEM_REPORT.test(raw) || PASTED_ERROR.test(raw),
    wordCount: wordCount(raw),
  };
}

/**
 * Where a phrase hits the prompt's words: every phrase word in order, with at most one extra word in total
 * between them. The indexes of the words it covered, or null. Greedy is exact here: taking the next word when it
 * matches never costs the one skip.
 */
export function phraseHit(words: string[], phrase: string[]): number[] | null {
  if (!phrase.length) return null;
  for (let s = 0; s < words.length; s++) {
    if (words[s] !== phrase[0]) continue;
    const at = [s];
    let skip = 1;
    for (let j = 1; j < phrase.length; j++) {
      const pos = at[at.length - 1]!;
      if (words[pos + 1] === phrase[j]) at.push(pos + 1);
      else if (skip && words[pos + 2] === phrase[j]) { skip -= 1; at.push(pos + 2); }
      else break;
    }
    if (at.length === phrase.length) return at;
  }
  return null;
}

/** "... before publishing", "before we ff to prod": a later step, not what this prompt asks for; left out of the match. */
const LATER = /\bbefore\s+(?:we\s+|you\s+|i\s+|it\s+)?(?:publish|releas|deploy|push|puch|psuh|ship|ff|fast.?forward|promot|merg)\w*[^.?!\n]*/gi;
/**
 * What the speaker says they will do themselves ("I'll push to prod after lunch"), or a pasted reply of the agent's
 * ("Say the word and I'll ... ship it to beta"): a statement, not an ask. Left out to the end of its sentence.
 */
const SPEAKER = /\bI(?:'ll|\u2019ll| will| am going to|'m going to|\u2019m going to)\b[^.?!\n]*/gi;
const now = (raw: string) => raw.replace(LATER, ' ').replace(SPEAKER, ' ');
/** Asked to talk it through first ("ask me questions first", "plan it first"): not a go for a job's steps. */
const NOT_YET = /\bask me (?:some |any |a few )?questions\b|\bquestions? first\b|\bplan (?:it |this )?first\b|\bdon'?t (?:start|run|do) (?:anything|it) yet\b/i;
/** Two ways real asks name where a ship goes without a ship verb: "make it to prod", "make sure the changes are on prod". */
const SHIP_IDIOM = /\bmake (?:it|this|that|them|these|those|everything|all of it) (?:to|on|onto|into) (?:the )?(?:prod|production|beta|staging)\b|\bmake sure\b[^.?!\n]{0,80}?\b(?:is|are) (?:both |all |also )?(?:on|in) (?:the )?(?:prod|production|beta|staging)\b/;
const shipIdiom = (s: ParsedSkill, text: string) => s.meta.job === 'ship' && SHIP_IDIOM.test(text);

/** A pasted error the agent should look at, not a job: "page not found", "got this on localhost". */
const PASTED_ERROR = /\bpage not found\b|\bgot this (?:error|on|in|when|after)\b/i;
/** How the person wants things done from now on ("always ...", "never ..."): a lesson, never an ask for a skill. */
const PREFERENCE = /^\s*(?:(?:okay|ok|so|and|also|but|please|no)[\s,]+)*(?:always|never|from now on|going forward|in (?:the )?future)\b/i;
/** The places a job goes to: a skill for one never comes for an ask that names only another. */
const TARGETS = new Set(['beta', 'prod', 'staging', 'main', 'master', 'dev', 'preview']);

const phrasesOf = (list: string | undefined) =>
  String(list ?? '').split(',').map((p) => split(lower(p.trim()))).filter((p) => p.length > 0);
/** Each asks phrase as written (for its phraseSha) and as words. */
const rawPhrases = (list: string | undefined) =>
  String(list ?? '').split(',').map((p) => ({ raw: p.trim(), words: split(lower(p.trim())) })).filter((p) => p.words.length > 0);

/** The places a skill is for: the place words of its asks and its name. */
const placesOf = (s: ParsedSkill) =>
  new Set([...phrasesOf(s.meta.asks).flat(), ...split(s.name.toLowerCase().replace(/-/g, ' '))].filter((w) => TARGETS.has(w)));

/**
 * D71 a: a 26 to 60 word ask is for this skill only when it names one of the skill's places and a verb of its job
 * ("... and push to prod if you need to"). A skill with no place keeps the 25-word cap.
 */
function longAskFits(np: NormPrompt, s: ParsedSkill): boolean {
  const cls = s.meta.job ? JOB_CLASSES.find((c) => c.job === s.meta.job) : undefined;
  const places = placesOf(s);
  if (!cls || !places.size || !np.words.some((w) => places.has(w))) return false;
  if (shipIdiom(s, classText(now(np.raw)))) return true;
  return np.words.some((w) => { const v = cls.vocab[w]; return v !== undefined && !TARGETS.has(v) && !TARGETS.has(canon(v)); });
}

/** The text a job class is matched on, as matchJob reads it. */
const classText = (raw: string) => lower(raw).replace(URL, ' url ').replace(VERSION_RE, ' ver ').replace(/\s+/g, ' ').trim();

/** 4.6 job cue for one skill: its class matched, an ask hit word for word, and how much of the prompt the asks cover. */
export function scoreJobCue(np: NormPrompt, s: ParsedSkill): { score: number; hits: number; classMatch: boolean; exact: boolean; phrase: string | null } {
  const cls = s.meta.job ? JOB_CLASSES.find((c) => c.job === s.meta.job) : undefined;
  const text = classText(now(np.raw));
  // The class's exclusions ("call it publish", "release notes", "I have released") say the prompt is not this
  // job at all, so they veto an ask word too: "publish" alone would otherwise hit them.
  if (cls?.exclude?.test(text)) return { score: 0, hits: 0, classMatch: false, exact: false, phrase: null };
  // Real asks name where a job goes; a skill for prod is not the one for an ask about staging only.
  const mine = placesOf(s);
  const asked = np.words.filter((w) => TARGETS.has(w));
  if (mine.size && asked.length && !asked.some((w) => mine.has(w))) return { score: 0, hits: 0, classMatch: false, exact: false, phrase: null };
  const classMatch = !!cls && (cls.pattern.test(text) || shipIdiom(s, text));
  const covered = new Set<number>();
  let exact = false;
  // 1b: the phrase that covered the most words (the first of equals), for the cue-miss count (4.19).
  let phrase: { raw: string; n: number } | null = null;
  for (const { raw, words: p } of rawPhrases(s.meta.asks)) {
    // A one-word ask is a cue only when it is the job's own word ("publish"), never a common one ("done", "test").
    if (p.length < 2 && !(cls && p[0]! in cls.vocab)) continue;
    if (p.every((w) => STOP.has(w))) continue;
    const at = phraseHit(np.words, p);
    if (!at) continue;
    exact = true;
    if (!phrase || at.length > phrase.n) phrase = { raw, n: at.length };
    for (const i of at) covered.add(i);
  }
  const hits = new Set([...covered].map((i) => np.words[i]!).filter((w) => np.content.includes(w))).size;
  const ratio = hits / Math.max(1, np.content.length);
  return { score: classMatch || exact ? Math.max(0.5, ratio) : ratio, hits, classMatch, exact, phrase: phrase?.raw ?? null };
}

/** Asking about the skill, not for it: "forget release-npm", "trail skills show release-npm". */
const MANAGES = /\b(?:trail\s+(?:skills?|forget)|forget|restore|retire|delete|remove|rename|edit)\b/i;

/** 4.6 name cue: the prompt holds the skill's name, or its dash words as a phrase. A one-word name is a common word, never a cue on its own. */
function nameCue(np: NormPrompt, s: ParsedSkill): boolean {
  const name = s.name.toLowerCase();
  const parts = split(name.replace(/-/g, ' '));
  if (parts.length < 2 || MANAGES.test(np.raw)) return false;
  return np.words.includes(name) || phraseHit(np.words, parts) !== null;
}

/**
 * "is it live", "did the deploy finish", "is 1.4.3 out", "is #4211 live": the subject a check answers (4.6), after
 * the lead words a person starts with.
 */
const CHECK_SUBJECT = /^\s*(?:(?:okay|ok|so|and|also|tell me)[\s,]+)*(?:is|did|has|was) (?:(?:it|that|this|the (?:deploy|release|publish|push|build|site|app|new version)|prod|production|beta)\b|v?\d+\.\d+\.\d+(?:-[0-9a-z.]+)?(?=[\s?!.,]|$)|#\d+\b|pr #?\d+\b)/i;

function checkCue(np: NormPrompt, s: ParsedSkill): boolean {
  const words = s.meta.job ? JOB_CLASSES.find((c) => c.job === s.meta.job)?.checkWords ?? [] : [];
  const raw = np.raw.toLowerCase();
  if (CHECK_SUBJECT.test(raw) && words.some((w) => np.words.includes(w) || new RegExp(`\\b${w}\\b`).test(raw))) return true;
  return phrasesOf(s.meta['status-asks']).some((p) => phraseHit(np.words, p) !== null);
}

const SAFE_VALUE = /^[A-Za-z0-9][A-Za-z0-9._@:+\/-]{0,99}$/;

const SCOPE_RANK: Record<Scope, number> = { personal: 0, repo: 1, team: 2 };
const worked = (c: Candidate) => c.state?.lastWorked ?? '';

/** Higher score, then more checked uses, then narrower scope, then newer last worked. */
function better(a: { cand: Candidate; score: number }, b: { cand: Candidate; score: number }): number {
  return b.score - a.score
    || (b.cand.state?.checkedUses ?? 0) - (a.cand.state?.checkedUses ?? 0)
    || SCOPE_RANK[a.cand.ref.scope] - SCOPE_RANK[b.cand.ref.scope]
    || worked(b.cand).localeCompare(worked(a.cand));
}

const safeParams = (p: Record<string, unknown>) => Object.fromEntries(Object.entries(p).filter(([, v]) => typeof v === 'string' && SAFE_VALUE.test(v))) as Record<string, string>;

/**
 * D118 b: the cue's values with the run's own bound ones under this prompt's: a version (or sha, PR, ...) an
 * earlier ask of the same run named holds for the run's life, across turns and re-sent blocks; one this prompt
 * names wins.
 */
export function withRunParams(cue: CueResult, runParams: Record<string, unknown>, np: NormPrompt): CueResult {
  const { values, notes } = resolveParams(cue.cand.skill.params, { ...safeParams(runParams), ...safeParams(np.params) });
  return { ...cue, values, notes };
}

/** 4.6. Ignores once-per-epoch: the caller decides between a block and a re-arm (3.2 step 8). */
export function matchCue(np: NormPrompt, cands: Candidate[], lastUsed: { id: string; at: string } | null, now: Date = new Date()): CueResult | null {
  if (np.raw.trim().length < 3 || np.wordCount > LONG_MAX_WORDS || np.problem || PREFERENCE.test(np.raw) || NOT_YET.test(np.raw)) return null;
  if (np.wordCount > MAX_WORDS) {
    if (np.status) return null;
    cands = cands.filter((c) => longAskFits(np, c.skill));
  }
  // Only a value of a shape's own characters goes into a step: never `;`, a space, `$(` or a backtick.
  const shaped = Object.fromEntries(Object.entries(np.params).filter(([, v]) => typeof v === 'string' && SAFE_VALUE.test(v)));
  const result = (kind: CueResult['kind'], cand: Candidate, score: number): CueResult => {
    const { values, notes } = resolveParams(cand.skill.params, shaped);
    return { kind, cand, score, values, notes };
  };
  if (np.status) {
    if (!lastUsed) return null;
    const at = Date.parse(lastUsed.at);
    if (Number.isNaN(at) || now.getTime() - at > DAY_MS) return null;
    const c = cands.find((x) => x.ref.id === lastUsed.id);
    if (!c || !c.skill.check || !checkCue(np, c.skill)) return null;
    return result('check', c, 1);
  }
  const named = cands.filter((c) => nameCue(np, c.skill)).map((cand) => ({ cand, score: scoreJobCue(np, cand.skill).score }));
  if (named.length) {
    const best = named.sort(better)[0]!;
    return result('name', best.cand, best.score);
  }
  const jobs = cands.flatMap((cand) => {
    const s = scoreJobCue(np, cand.skill);
    return s.classMatch || s.exact ? [{ cand, score: s.score, phrase: s.phrase }] : [];
  });
  if (!jobs.length) return null;
  const best = jobs.sort(better)[0]!;
  // 1b (R30): the phrase that fired it, as its sha only; the candidate carries it to its injection.
  const sha = best.phrase ? phraseSha(best.phrase) : null;
  return { ...result('job', { ...best.cand, phraseSha: sha }, best.score), phraseSha: sha };
}

/** Why a command can't come back in a block: the risk rules' reason (4.11), or a password written in it. */
const riskOf = (cmd: string) => neverSave(cmd) ?? (literalPassword(cmd) ? 'has a password written in it' : null);

/**
 * The risk rules again at recall time, on what a block would show: a SKILL.md can be edited by hand after Trail
 * wrote it, so a step, the check or a check-first line the rules refuse (a download piped into a shell, `rm -rf ~`,
 * sudo, a credential file, Trail itself) keeps the whole skill out. `values`: the block's values, filled in first
 * (a param default can be edited too). The reason in words ("step 3 runs sudo"), or null.
 */
export function refusedAtRecall(s: ParsedSkill, values: Record<string, string> = {}): string | null {
  for (const st of s.steps) {
    const why = riskOf(fillParams(st.cmd, values));
    if (why) return `step ${st.n} ${why}`;
  }
  if (s.check) {
    const why = riskOf(fillParams(s.check, values));
    if (why) return `its check ${why}`;
  }
  for (const line of String(s.meta['check-first'] ?? '').split(' ; ').map((x) => x.trim()).filter(Boolean)) {
    const why = riskOf(fillParams(line, values));
    if (why) return `a check-first line ${why}`;
  }
  return null;
}

/**
 * A skill the index line names as not used: needs-fix by its record, or refused at recall (`why`). 1b:
 * `correctedStep`, for a skill corrected twice, is the step both corrected uses ended at, else null (4.17).
 */
export type NotUsed = Candidate & { why?: string; correctedStep?: number | null };

/** The step both of the last two corrected uses touched (the step that failed, else the last that ran), or null. */
function correctedStepOf(id: string, env?: NodeJS.ProcessEnv): number | null {
  const lines = readLedger(id, env);
  const corrected = new Set(lines.flatMap((l) => (l.event === 'corrected' ? [l.useId] : [])));
  const touched = lines.flatMap((l) => (l.event === 'use' && corrected.has(l.useId) ? [l.failedStep ?? (l.stepsRan.length ? Math.max(...l.stepsRan) : null)] : []));
  const [a, b] = touched.slice(-2);
  return a !== undefined && a !== null && a === b ? a : null;
}

const CORRECTED_WHY = /^corrected after its use on (.+) and (.+)$/;

/** Candidate and active skills in scope; needs-fix ones, and ones the risk rules refuse now, come back separately for the index line. */
export function candidatesHere(ctx: ScopeCtx): { cands: Candidate[]; needsFix: NotUsed[]; adopted: string[] } {
  // A needs-fix skill fixed by hand goes back to what it was in readSkill, so the state is read again after any.
  const before = readSkillsState(ctx.env).skills;
  let fixed = false;
  // Phase 2 (4.6, R8): a proposal the person copied over the file is Trail's own again; an unfinished write is finished.
  const adopted: string[] = [];
  const read = listSkills(ctx).flatMap((ref) => {
    const known = before[ref.id] ?? null;
    const skill = readSkill(ref, known);
    if (known?.status === 'needs-fix') fixed = true;
    if (skill && (known?.proposed || known?.pendingWrite)) {
      fixed = true;
      try {
        if (adoptIfCopied(ref, known, skill.hash, ctx.env)) adopted.push(ref.name);
      } catch { /* the skill still reads */ }
    }
    return skill ? [{ ref, skill }] : [];
  });
  const states = fixed ? readSkillsState(ctx.env).skills : before;
  const cands: Candidate[] = [];
  const needsFix: NotUsed[] = [];
  // 1b: where it was found, so a block can check its anchors at injection (4.18).
  const here = { checkout: ctx.checkout, env: ctx.env };
  for (const { ref, skill } of read) {
    const state = states[ref.id] ?? null;
    const status = state?.status ?? 'candidate';
    if (status !== 'needs-fix' && status !== 'candidate' && status !== 'active') continue;
    const refused = refusedAtRecall(skill);
    if (refused) needsFix.push({ ref, skill, state, here, why: refused });
    else if (status === 'needs-fix') {
      const step = state && CORRECTED_WHY.test(state.statusWhy ?? '') ? correctedStepOf(ref.id, ctx.env) : null;
      needsFix.push({ ref, skill, state, here, ...(step !== null ? { correctedStep: step } : {}) });
    } else cands.push({ ref, skill, state, here });
  }
  return { cands, needsFix, adopted };
}

const GATED_WORDS: Record<string, string> = {
  publish: 'publishing', 'push-prod': 'the prod push', deploy: 'deploying', merge: 'merging', migrate: 'migrating', prune: 'pruning', login: 'logging in',
};
const INDEX_MAX = 500;
const INDEX_TAIL = '. When the person asks for one of these jobs, its exact steps come in with their message.';

/** The name a skill goes by in anything Trail says or an agent runs: its folder's, never a name edited into the file. */
export const nameOf = (c: Pick<Candidate, 'ref' | 'skill'>) => flatLine(c.ref.name || c.skill.name, 60);

function indexItem(c: Candidate, gone: boolean): string {
  const asks = String(c.skill.meta.asks ?? '').split(',').map((a) => flatLine(a, 60)).filter(Boolean).slice(0, 3);
  const kinds = [...new Set(c.skill.steps.flatMap((s) => (s.gated ? [GATED_WORDS[s.gated] ?? 'running it'] : [])))].slice(0, 2);
  const flags = [c.state?.status === 'candidate' || !c.state ? 'new' : '', kinds.length ? `asks before ${kinds.join(' and ')}` : ''].filter(Boolean);
  return `${nameOf(c)}${asks.length ? ` (${asks.join(', ')})` : ''}${flags.length ? ` ${flags.join(', ')}` : ''}${gone ? ` ${ANCHOR_COPY.index}` : ''}`;
}

/**
 * Why a needs-fix skill isn't used, in the index's words (4.17, J14a): 1a's failed words as they are; two
 * corrections as `step {n} was corrected on {d1} and {d2}`, or `corrected on {d1} and {d2}` when they touched no
 * one step.
 */
export function needsFixWords(c: NotUsed): string | undefined {
  if (c.why) return c.why;
  const why = c.state?.statusWhy;
  const m = why ? CORRECTED_WHY.exec(why) : null;
  if (!m) return why;
  return typeof c.correctedStep === 'number' ? `step ${c.correctedStep} was corrected on ${m[1]} and ${m[2]}` : `corrected on ${m[1]} and ${m[2]}`;
}

/**
 * The SessionStart index line (4.7), '' when none. 1b (4.18, 4.19): with `now`, a skill unused for 60 days is left
 * out (its cues still fire); `gone` says which listed skills may be out of date (checked for the 5 listed only).
 */
export function indexLine(cands: Candidate[], needsFix: NotUsed[], opts: { now?: Date; gone?: (c: Candidate) => boolean } = {}): string {
  const top = [...cands]
    .filter((c) => !c.state || c.state.status === 'candidate' || c.state.status === 'active')
    .filter((c) => !(opts.now && c.state && unusedSince(c.state, opts.now)))
    .sort((a, b) => (b.state?.checkedUses ?? 0) - (a.state?.checkedUses ?? 0) || worked(b).localeCompare(worked(a)))
    .slice(0, 5)
    .map((c) => {
      let gone = false;
      try { gone = !!opts.gone?.(c); } catch { /* a check that throws is not gone */ }
      return indexItem(c, gone);
    });
  const fix = needsFix.slice(0, 2).map((c) => {
    const why = needsFixWords(c);
    return `${nameOf(c)} needs a fix${why ? ` (${flatLine(why, 80)})` : ''}, not used`;
  });
  const items = [...top, ...fix];
  const line = (list: string[]) => `[trail] Trail skills here: ${list.join(' · ')}${INDEX_TAIL}`;
  while (items.length && line(items).length > INDEX_MAX) items.pop();
  return items.length ? line(items) : '';
}
