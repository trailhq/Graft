/**
 * The job vocabulary (design 4.14): which short typed asks name a job, from a
 * fixed list of verb classes ported from the mining's lexicon. Only canonical
 * words and values of known shapes leave this file, never the typed text.
 *
 * An ask is a job only when it is 25 words or fewer, not a status or history
 * question ("did you push?", "is it live", "..., right?") and not a problem
 * report ("prod is broken", "why ..."). Fenced code, quoted lines and very
 * long lines are pasted context, not the ask, and are dropped first.
 *
 * Tuned on one person's prompts; the real near misses live in the private
 * lab, and every test here is synthetic. Pure: no files, no clock.
 */
import type { CheckFamily, JobClass, JobMatch, PromptParams } from './types.js';

/** Words that may sit between "run" and "tests": never a conjunction or another verb ("run it and write tests"). */
const GAP = String.raw`(?:(?!(?:and|then|or|but|to|write|add|fix|create|update|make|remove|delete|skip)\b)[\w./:-]+ ){0,3}?`;
const RUNNER = String.raw`(?:npm|pnpm|yarn|bun)(?: run)? test\b|npx (?:vitest|jest|playwright test)\b|go test\b|cargo test\b|make test\w*|python3? -m pytest\b|pytest\b|bats\b|rspec\b|jest\b|vitest\b`;
/** D136 (3): up to 2 words naming what to test before a runner ("sql-output bats"), never a verb that sets it up. */
const NAMED = String.raw`(?:(?!(?:and|then|or|but|to|write|add|fix|create|update|make|remove|delete|skip|install|configure|set|setup|upgrade|migrate|use|switch|what|how|which|why)\b)[\w./:-]+ ){0,2}?`;
/** The tests job (4.14, D56b). */
const TESTS = new RegExp([
  String.raw`\b(?:re-?run|re run|run|kick off|execute)\b (?:the |all (?:of )?(?:the )?|our |my |these |those )?${GAP}(?:tests?|test ?suites?|suites?|specs?)\b`,
  String.raw`\b(?:run|re-?run)\b (?:\S+ ){0,2}?(?:${RUNNER})`,
  String.raw`^\s*(?:please |can you |could you |pls )?(?:${RUNNER})`,
  // D136 (3): "sql-output bats please", "api tests", "sql-output tests please": the whole ask names what to test.
  String.raw`^\s*(?:please |can you |could you |pls )?(?:the )?${NAMED}(?:bats|rspec|pytest|jest|vitest)\b(?: (?:please|pls|again|now))?\s*[.!]*$`,
  String.raw`^\s*(?:please |pls )?(?:the )?(?!(?:write|add|fix|new|more|unit|my|our|your|these|those|some|any|no)\b)[\w./:-]+ tests?(?: (?:please|pls|again|now))?\s*[.!]*$`,
  String.raw`\bmake sure (?:that )?(?:the |all (?:the )?)?(?:\w+ )?tests? (?:still )?(?:pass|are passing|are green|go green)\b`,
  String.raw`\bget (?:the |all (?:the )?)?(?:\w+ )?tests? (?:passing|green|to pass)\b`,
  String.raw`\b(?:integration|e2e|end-to-end|smoke|regression|acceptance) tests?\b`,
  String.raw`\btest (?:it|this|that|everything|all(?: of (?:it|this))?) before (?:push|commit|merg|ship|deploy)\w*`,
].join('|'));
/**
 * Not the tests job: how-to and wh- questions, a status question with no lead verb ("integration tests
 * green?"), writing or changing tests, a test environment or account, testing it yourself.
 */
const TESTS_NOT = new RegExp([
  String.raw`^\s*(?:(?:ok(?:ay)?|so|and|hmm)[\s,]+)*(?:how|what|which|where|when|why|who)\b`,
  String.raw`\b(?:tests?|suites?|specs?)\b[^?]{0,30}\b(?:pass\w*|green|red|fail\w*|ok|done|finish\w*|running|broken)\s*\?\s*$`,
  String.raw`\b(?:write|writing|add|adding|create|fix|fixing|update|remove|delete|skip|mock|refactor|rewrite|cover)\w* (?:\w+ ){0,3}?(?:tests?|specs?)\b`,
  String.raw`\btest (?:env|environment|channel|account|data|mode|user|key|card|server|db|database|webhook|token|number|payment)s?\b`,
  String.raw`\b(?:myself|yourself|ourselves)\b|\bfor (?:me|us|him|her|them) to (?:re-?)?(?:run|test)\b`,
  String.raw`\b(?:install|configure|set ?up|upgrade|migrate|switch)\w* (?:\w+ ){0,3}?(?:to )?(?:bats|rspec|pytest|jest|vitest)\b`,
].join('|'));
/** D136 (3): ship or deploy (it) to a named place: the ship job when the repo has a branch by that name. */
const SHIP_TO = /\b(?:ship|deploy)\w*(?: (?:it|this|that|them))? to (?:the )?([\w./-]+)/;

type JobDef = { job: JobClass; pattern: RegExp; exclude?: RegExp; vocab: Record<string, string>; noun: string; checkWords: string[] };

/** Surface forms to canonical words, one map per class. */
const words = (pairs: Record<string, string[]>): Record<string, string> =>
  Object.fromEntries(Object.entries(pairs).flatMap(([canon, forms]) => [canon, ...forms].map((f) => [f, canon])));

export const JOB_CLASSES: ReadonlyArray<JobDef> = [
  {
    job: 'release',
    pattern: /\b(publish\w*|re-?publish|release\w* (a |the )?(new |next )?(version|ver|patch|minor|major)|cut (a |that |the )?release|redo the (npm )?publish|npm publish|bump (the )?version)\b/,
    exclude: /publish\w* (on|to) (the )?(web|website)|call it publish|publishable|\brelease (the )?notes\b|\b(i|we)( have|'ve| had)? (already )?released\b/,
    vocab: words({ publish: ['publishing', 'published', 'publishes', 'republish', 're-publish'], release: ['releases', 'releasing'], bump: ['bumping'], npm: [] }),
    noun: 'release',
    checkWords: ['published', 'released', 'out', 'live', 'up'],
  },
  {
    job: 'ship',
    pattern: /\b(push|puch|ff|fast.?forward|promote|deploy|ship|merge|update|move|get)\w* (\w+ ){0,4}(to |for |on |in |into )?(the )?(beta|prod|production|staging)\b|\bff to prod\b|\bupdate prod\b|^\s*(please )?ship it\b/,
    exclude: /not working on (prod|beta)/,
    vocab: words({
      push: ['pushed', 'pushing', 'puch'], ff: ['fast-forward', 'fastforward'], promote: ['promoted'], deploy: ['deploying', 'deployed'], ship: ['shipping'],
      merge: ['merged'], update: ['updated'], beta: [], prod: ['production'], staging: [],
    }),
    noun: 'ship',
    checkWords: ['live', 'deployed', 'updated', 'up', 'out', 'green'],
  },
  {
    job: 'pr-green',
    pattern: /\b(ci\b|ci's|checks? (are |is )?fail\w*|failing (tests|checks)|failed tests|review comments|nitpicks|make (the )?ci (go )?green|ci goes? green|review.?bot)/,
    vocab: words({ ci: ["ci's"], checks: ['check'], review: ['reviews'] }),
    noun: 'CI fix',
    checkWords: [],
  },
  {
    job: 'sweep',
    pattern: /\b(go through|sweep|verify|check)\b.{0,40}\b(all|other|more|newer|backlog|recent)\b.{0,25}\b(prs|pull requests|issues)\b|\bclose (more )?(issues|prs)\b/,
    vocab: words({ sweep: [], prs: ['pull-requests'], issues: [] }),
    noun: 'PR sweep',
    checkWords: [],
  },
  {
    job: 'run-local',
    pattern: /\b(open (it|this|the \w+)? ?(locally|in (the )?browser|on (a )?local)|localhost|local server|run it locally|open locally)\b/,
    vocab: words({ open: [], locally: [], localhost: [] }),
    noun: 'local run',
    checkWords: [],
  },
  {
    job: 'report',
    pattern: /\b(any new (users|people)|new users? (since|till|through|we have|came)|how many (new )?(users|people) (have|came|joined))\b/,
    vocab: words({ new: [], users: ['user', 'people'], signups: ['signup'] }),
    noun: 'report',
    checkWords: [],
  },
  {
    // D56b, rebuilt from real asks: none said "run the integration tests"; they said "run the tests", "rerun
    // the e2e tests", named the runner, or "make sure the tests pass". "Test this thoroughly end to end" is a
    // feature check the agent designs each time, not a test run, so it stays out.
    job: 'tests',
    pattern: TESTS,
    exclude: TESTS_NOT,
    vocab: words({ integration: [], e2e: ['end-to-end'], tests: ['test', 'suite', 'suites', 'specs', 'spec'] }),
    noun: 'test run',
    checkWords: ['passing', 'green', 'pass', 'passed'],
  },
];

/** Jobs that can reach moment 2, and the check families that fit each (4.2). */
export const OFFER_FAMILIES: Readonly<Partial<Record<JobClass, CheckFamily[]>>> = Object.freeze({
  release: ['npm-view'], ship: ['deploy', 'ls-remote', 'push'], tests: ['tests'], report: ['query'],
});

/** pr-green and sweep: judgement loops, left out by spec 23. Never offered, never compiled. */
export const JUDGEMENT_JOBS: ReadonlySet<JobClass> = new Set<JobClass>(['pr-green', 'sweep']);

/** Lead words may stack ("ok so did it..."); a tag that asks for a yes ("..., didn't it?") is a status question too. */
export const STATUS_OR_HISTORY =
  /^\s*(?:(?:okay|ok|so|and|also|hey|btw|wait|hmm|tell(?: me)?)[\s,]+)*(did|is|was|has|have|are|were|does|how did|what did|when did|where did)\b|\b(did (you|we)|is it (live|done|published|deployed|out|up|green)|how did (we|you)|check (now )?if)\b|\b(right|correct)\?\s*$|\b(?:is|are|was|were|did|does|do|has|have)n'?t (?:it|they|we|you|that|he|she)\?\s*$/i;
export const PROBLEM_REPORT = /\b(not working|(does|did|do)n'?t work|did not work|does not work|went wrong|still (broken|failing|not)|is broken)\b|^\s*why\b/i;
export const MAX_ASK_WORDS = 25;

/**
 * The person's own ask in a typed message: fenced code blocks (an unclosed one
 * runs to the end), quoted lines (`>`) and lines of 800 characters or more
 * dropped. Every matcher of typed text reads this, not the raw message.
 */
export function askText(typed: string): string {
  const t = String(typed ?? '').replace(/```[\s\S]*?(?:```|$)/g, '\n');
  return t.split(/\r?\n/).filter((l) => !/^\s*>/.test(l) && l.length < 800).join('\n').trim();
}

export function wordCount(text: string): number {
  return String(text ?? '').split(/\s+/).filter(Boolean).length;
}

export function isStatusOrHistory(text: string): boolean {
  return STATUS_OR_HISTORY.test(askText(text));
}

const URL = /\b[a-z][a-z0-9+.-]*:\/\/\S+/gi;
const VERSION = /\bv?\d+\.\d+\.\d+(?:-[0-9a-z.]+)?\b/gi;

/**
 * Job of a typed ask, or null. Applies the 25-word cap, the status/history filter and the problem filter. `hasBranch`:
 * whether the repo has a branch by a name, for "deploy it to <branch>" (D136 (3)); without it only beta, prod and
 * staging name a ship.
 */
export function matchJob(typedText: string, opts: { anyLength?: boolean; hasBranch?: (name: string) => boolean } = {}): JobMatch | null {
  const ask = askText(typedText);
  // The cap is for matching skills; D120 (1)'s continuation of the open run's own job reads any length.
  if (!ask || (!opts.anyLength && wordCount(ask) > MAX_ASK_WORDS)) return null;
  if (STATUS_OR_HISTORY.test(ask) || PROBLEM_REPORT.test(ask)) return null;
  const t = ask.toLowerCase().replace(URL, ' url ').replace(VERSION, ' ver ').replace(/\bfast forward/g, 'fast-forward').replace(/\s+/g, ' ').trim();
  for (const c of JOB_CLASSES) {
    if (!c.pattern.test(t) || c.exclude?.test(t)) continue;
    const found: string[] = [];
    for (const w of t.split(/[^a-z0-9'-]+/)) {
      const canon = c.vocab[w] ?? c.vocab[w.replace(/'s$/, '')];
      if (canon && !found.includes(canon)) found.push(canon);
    }
    return { job: c.job, words: found };
  }
  const to = opts.hasBranch ? SHIP_TO.exec(t) : null;
  if (to && opts.hasBranch!(to[1]!.replace(/[.]+$/, ''))) {
    const ship = JOB_CLASSES.find((c) => c.job === 'ship')!;
    if (!ship.exclude?.test(t)) return { job: 'ship', words: [...new Set(t.split(/[^a-z0-9'-]+/).map((w) => ship.vocab[w]).filter((w): w is string => !!w))] };
  }
  return null;
}

const NOT_A_BRANCH = new Set(['to', 'and', 'the', 'is', 'of', 'for', 'from', 'then', 'with', 'in', 'on', 'it', 'so', 'a', 'name', 'called', 'named']);

/** Shape values in a typed ask (semver, sha, #PR, port, branch after 'branch', date). */
export function promptParams(typedText: string): PromptParams {
  const t = askText(typedText);
  const out: PromptParams = {};
  const version = /\bv?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)\b/.exec(t);
  if (version) out.version = version[1]!.replace(/\.$/, '');
  for (const m of t.matchAll(/\b[0-9a-f]{7,40}\b/g)) {
    if (/\d/.test(m[0]) && /[a-f]/.test(m[0])) { out.sha = m[0]; break; }
  }
  const pr = /(?:^|\s)#(\d+)\b|\bpr\s*#?(\d+)\b|\/pull\/(\d+)/i.exec(t);
  if (pr) out.pr = pr[1] ?? pr[2] ?? pr[3];
  const port = /\b(?:localhost|127\.0\.0\.1|0\.0\.0\.0):(\d{2,5})\b|--port[= ](\d{2,5})\b|\bPORT=(\d{2,5})\b|\bport (\d{2,5})\b/i.exec(t);
  if (port) out.port = port[1] ?? port[2] ?? port[3] ?? port[4];
  const branch = /\bbranch(?: called| named)? ([\w./-]+)/i.exec(t);
  if (branch && !NOT_A_BRANCH.has(branch[1]!.toLowerCase()) && branch[1]!.length >= 2) out.branch = branch[1];
  const date = /\b20\d\d-\d\d-\d\d\b/.exec(t);
  if (date) out.date = date[0];
  return out;
}
