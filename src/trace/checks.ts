/**
 * The checks that prove a job worked (design 4.2), read from a command and
 * what it printed: tests whose runner says they passed, `npm view` showing
 * the version this run is about, a deploy that is success or READY at the
 * pushed commit, CI checks all passing, `git ls-remote` showing a pushed
 * commit, a report's query that came back. A check needs the call not to
 * have failed, and anything pending, failing or cancelled is not a pass.
 *
 * And how a turn ended (4.3), on the agent's last words: in a failure, in a
 * question, or done. Never stored.
 *
 * Pure: no files, no clock.
 */
import { BATS, batsPassed, DEPLOY_STEP, GCLOUD_DESCRIBE, gcloudReady, HEALTH_CURL, healthy, inLoop, isHealthCurl } from './check-reads.js';
import { OFFER_FAMILIES } from './jobs.js';
import { bareCommand, commandKind, simpleCommands, splitTop, stripOutputFilters } from './shell.js';
import type { CallKind, CheckFamily, CheckHit, JobClass, PromptParams, RunCall } from './types.js';

export interface RunFacts {
  /** Values seen earlier in the run that a check can confirm. */
  versions: string[];           // npm publish *-<ver>.tgz, npm version <ver>, '+ pkg@ver' in a publish tail, promptParams.version
  shas: string[];               // <sha>:refs/heads/x refspecs, `git rev-parse` tails, commits/<sha>, push tails' new sha
  pushedBranches: string[];     // targets of successful pushes, in order (4.2)
  pr?: string;
  /** A publish worked in this run: with no version known, npm view may show any (4.2). */
  published?: boolean;
  /** D140: a push or a deploy step worked in this run, so a health read after it is a deploy check. */
  deployed?: boolean;
}

/** npm-view, deploy, gh-checks, ls-remote: they only read, so a non-final one is look-only (4.5 step 2). */
export const READ_ONLY_FAMILIES: ReadonlySet<CheckFamily> = new Set<CheckFamily>(['npm-view', 'deploy', 'gh-checks', 'ls-remote']);

/**
 * The commit a skill works out when it runs: `$(git rev-parse HEAD)` (the `{sha}` default), `--short`, `--verify`
 * (D71 c). A deploy status read at it is a deploy check like one at a written-out sha; it just names no sha.
 */
export const HEAD_SHA = String.raw`\$\(\s*git\s+rev-parse\s+(?:--short(?:=\d+)?\s+|--verify\s+)?HEAD\s*\)`;

/** Python's runners, through uv, poetry or pdm too: pytest, `python -m pytest|unittest`, tox, nox. */
const PY_TESTS = /^(?:(?:uv|poetry|pdm) run (?:-- )?)?(?:pytest\b|python[\d.]* -m (?:pytest|unittest)\b)|^(?:tox|nox)(?=\s|$)/;
/** A runner run from a venv or any other bin folder (`.venv/bin/pytest`, `/x/venv/bin/python3`): its folder goes before matching. */
const BIN_DIR = /^(?:[^\s'"`$;|&()<>]*\/)?bin\/(?=(?:python[\d.]*|pytest|tox|nox)(?:\s|$))/;

/** Anchored on a simple command after its env prefixes and wrappers. */
const FAMILIES: Array<[CheckFamily, RegExp]> = [
  ['tests', /^(?:npm (?:test|t)\b|npm run test[:\w-]*|pnpm (?:run )?test[:\w-]*|yarn (?:run )?test\b|bun test\b|npx (?:vitest|jest)\b|vitest run\b|jest\b|go test\b|cargo test\b|node\b.*\s--test\b|make test[\w-]*)/],
  ['tests', PY_TESTS],
  ['tests', new RegExp(`^${BATS}`)], // D140
  ['npm-view', /^npm (?:view|v|info|show) (?!-)(\S+)/],
  ['deploy', new RegExp(String.raw`^gh api\b.*\/commits\/(?:([0-9a-f]{7,40})|${HEAD_SHA})\/(?:statuses|status|check-runs)\b|^(?:npx )?vercel (?:inspect|ls|list)\b|^(?:npx )?netlify (?:status|deploy:list)\b|^fly(?:ctl)? status\b|^kubectl rollout status\b`)],
  ['deploy', new RegExp(`^(?:${GCLOUD_DESCRIBE}|${HEALTH_CURL})`)], // D140
  ['gh-checks', /^gh pr checks(?:\s+#?(\d+))?|^gh run watch\b.*\s--exit-status\b|^gh run view (?:-\S+\s+)*\d+/],
  ['ls-remote', /^git ls-remote(?:\s+-\S+)*\s+(\S+)\s+(\S+)/],
  // A step, not a read: passes when its output shows the remote ref moved (D56a).
  ['push', /^git(?:\s+-[Cc]\s+\S+|\s+--[\w-]+=\S+)*\s+push\b/],
];
const QUERY = /\bpsql\b.*\s(?:-c|--command)\b|\bsqlite3\b \S+ ["']|\bmysql\b.*\s-e\b|\bbq\s+query\b|\bsupabase\b.*\b(?:sql|query)\b|\bcurl\b.*\.supabase\.co\/rest\/v1\//;

/** `poll`: a loop that waits on a deploy status (D59c), judged by the last state it printed. `sha`: the commit it waits on. */
type FamilyHit = { family: CheckFamily; m: RegExpExecArray | null; poll?: true; sha?: string };

const BATS_RE = new RegExp(`^${BATS}`);

const pushFits = (job: JobClass | null) => job !== null && (OFFER_FAMILIES[job] ?? []).includes('push');

/**
 * The family and its match, from the last simple command that has one. A push is a step that only doubles
 * as a check (D56a): in a call that also reads a check or runs tests, that one wins, unless the push is
 * the job's own proof (ship).
 */
function simpleFamily(cmd: string, job: JobClass | null): FamilyHit | null {
  const simple = simpleCommands(cmd);
  let push: FamilyHit | null = null;
  for (let i = simple.length - 1; i >= 0; i--) {
    const bare = bareCommand(simple[i]!).replace(BIN_DIR, '');
    let hit: FamilyHit | null = null;
    for (const [family, re] of FAMILIES) {
      const m = re.exec(bare);
      if (m) { hit = { family, m }; break; }
    }
    if (!hit && job === 'report' && QUERY.test(bare)) hit = { family: 'query', m: null };
    if (hit?.family === 'deploy' && isHealthCurl(bare) && inLoop(cmd)) hit = null; // D140: a wait, not a check
    if (!hit) continue;
    if (hit.family !== 'push') return push && pushFits(job) ? push : hit;
    push ??= hit;
  }
  return push;
}

/**
 * A deploy status read anywhere in a loop, `$(…)` included: a commit's statuses by a literal sha or a variable
 * (`commits/$SHA/statuses`), `vercel inspect|ls`, netlify, fly, kubectl, or Vercel's deployments API by curl.
 */
const DEPLOY_READ = new RegExp(String.raw`\bgh api\b[^\n]*?\/commits\/(?:([0-9a-f]{7,40})|\$\{?([A-Za-z_]\w*)\}?|${HEAD_SHA})\/(?:statuses|status|check-runs)\b|\b(?:npx )?vercel (?:inspect|ls|list)\b|\bnetlify (?:status|deploy:list)\b|\bfly(?:ctl)? status\b|\bkubectl rollout status\b|\bcurl\b[^\n]*?\bapi\.vercel\.com\/v\d+\/deployments\b`);
const LOOP_HEAD = /^\s*(?:for|while|until)\b/;

/** D59c: one top-level piece that is a loop which sleeps and reads a deploy status. `whole`: where its sha variable is set. */
function deployPoll(piece: string, whole: string): FamilyHit | null {
  if (!LOOP_HEAD.test(piece) || !/\bsleep\b/.test(piece)) return null;
  const m = DEPLOY_READ.exec(piece);
  if (!m) return null;
  const sha = m[1] ?? (m[2] ? new RegExp(`(?:^|[\\s;&|(])${m[2]}=["']?([0-9a-f]{7,40})\\b`).exec(whole)?.[1] : undefined);
  return { family: 'deploy', m: null, poll: true, ...(sha ? { sha } : {}) };
}

/**
 * The family of a whole call. A loop that polls a deploy status (D59c) is a deploy check unless a family read
 * after the loop decides (a one-shot `vercel ls` after it); a push after the loop yields to it as in D56a.
 */
function familyMatch(cmd: string, job: JobClass | null): FamilyHit | null {
  const text = stripOutputFilters(String(cmd ?? ''));
  if (/\bsleep\b/.test(text) && /\b(?:for|while|until)\b/.test(text)) {
    const pieces = splitTop(text);
    for (let i = pieces.length - 1; i >= 0; i--) {
      const poll = deployPoll(pieces[i]!.text, text);
      if (!poll) continue;
      const rest = pieces.slice(i + 1).map((p) => `${p.text}${p.sep ? ` ${p.sep} ` : ''}`).join('');
      const later = rest ? simpleFamily(rest, job) : null;
      return later && !(later.family === 'push' && !pushFits(job)) ? later : poll;
    }
  }
  return simpleFamily(text, job);
}

/** The family a command belongs to, from the command alone. Cheap: PostToolUse uses it to decide whether to write a mark. */
export function checkFamilyOf(cmd: string, job: JobClass | null): CheckFamily | null {
  return familyMatch(cmd, job)?.family ?? null;
}

/**
 * What a Bash call is (4.1): plumbing, work, look or step. A simple command
 * that is a read-only check (npm view, a deploy status, CI checks, ls-remote)
 * only reads, so it counts as look; the rest of the command still decides.
 */
export function callKind(cmd: string, job: JobClass | null): CallKind {
  const kinds = simpleCommands(String(cmd ?? '')).map((simple) => {
    const fam = familyMatch(simple, job)?.family;
    return fam && READ_ONLY_FAMILIES.has(fam) ? 'look' : commandKind(simple);
  });
  if (kinds.every((k) => k === 'plumbing')) return 'plumbing';
  if (kinds.includes('step')) return 'step';
  return kinds.includes('work') ? 'work' : 'look';
}

/**
 * A call's command as text: `cmd`, or for a call kept piece by piece (over 2,000 characters, D58c) its pieces
 * joined by their separators, a piece not kept standing as `:`.
 */
export function callText(c: Pick<RunCall, 'cmd' | 'parts'>): string {
  if (c.cmd !== null) return c.cmd;
  if (!c.parts?.length) return '';
  return c.parts.map((p) => `${p.cmd ?? ':'}${p.sep ? (p.sep === ';' ? '; ' : ` ${p.sep} `) : ''}`).join('').trim();
}

const HEAD = 1500;
const TAIL = 2500;
const ends = (t: string) => (t.length > HEAD + TAIL ? `${t.slice(0, HEAD)}\n${t.slice(-TAIL)}` : t);
const escapeRe = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** `v` (with or without a leading v) as a whole version in `text`: 1.4.3 is not in 1.4.30. */
export const hasVersion = (text: string, v: string) => new RegExp(`(?<![\\w.-])v?${escapeRe(v)}(?![\\w-]|\\.\\d)`).test(text);
const SEMVER = /(?<![\w.-])v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)(?![\w-]|\.\d)/;

/**
 * The runner's own summary says whether the tests passed. With none (an unknown runner), no failure text
 * is a pass only when the call's exit code is the runner's: through a pipe it is the last program's
 * (`| head` cut the summary off, `| grep -v` hid the failures), so it says nothing.
 */
function testsPassed(text: string, piped: boolean): { passed: boolean; count?: number } {
  const lines = text.split(/\r?\n/);
  const num = (re: RegExp) => { const m = re.exec(text); return m ? Number(m[1]) : undefined; };
  const summary = lines.filter((l) => /^\s*(?:Test Files|Tests:?|Test Suites:)\s/.test(l));
  if (summary.length) {
    const passed = summary.some((l) => /\b[1-9]\d* passed/.test(l)) && !summary.some((l) => /\b[1-9]\d* failed/.test(l));
    return { passed, count: num(/^\s*Tests:?\s+(?:\d+ \w+(?:,| \|) )*?(\d+) passed/m) };
  }
  if (/^[#ℹ]\s*(?:pass|fail) \d+/m.test(text)) return { passed: /^[#ℹ]\s*fail 0\b/m.test(text), count: num(/^[#ℹ]\s*pass (\d+)/m) };
  // unittest: `Ran 4 tests in 0.002s`, then `OK` or `FAILED (failures=1)`.
  if (/^Ran \d+ tests? in /m.test(text)) return { passed: /^OK\b/m.test(text) && !/^FAILED\b/m.test(text), count: num(/^Ran (\d+) tests? in /m) };
  if (/test result: /.test(text)) return { passed: /test result: ok\b/.test(text) && !/test result: FAILED/.test(text), count: num(/test result: ok\. (\d+) passed/) };
  if (/^(?:ok|FAIL|--- FAIL)\s/m.test(text)) return { passed: /^ok\s/m.test(text) && !/^(?:FAIL|--- FAIL|panic:)/m.test(text) };
  if (/\d+ (?:passed|failed|errors?)\b/.test(text)) return { passed: /\d+ passed/.test(text) && !/\b[1-9]\d* (?:failed|errors?)\b/.test(text), count: num(/(\d+) passed/) };
  // mocha
  if (/^\s*\d+ (?:passing|failing)\b/m.test(text)) return { passed: /^\s*[1-9]\d* passing\b/m.test(text) && !/^\s*[1-9]\d* failing\b/m.test(text), count: num(/^\s*(\d+) passing\b/m) };
  return { passed: !piped };
}

const DEPLOY_OK = /^(?:success|ready|completed successfully)$/i;
const DEPLOY_BAD = /^(?:pending|failure|failed|error|errored|canceled|cancelled|queued|in_progress|building|initializing|action_required|timed_out)$/i;

function deployState(text: string): { passed: boolean; state?: string } {
  const states: string[] = [];
  for (const m of text.matchAll(/"(?:state|status|conclusion)"\s*:\s*"([^"]+)"/gi)) states.push(m[1]!);
  for (const m of text.matchAll(/^\s*(?:state|status)\s*[:=]?\s*[●•]?\s*([A-Za-z_]+)\s*$/gim)) states.push(m[1]!);
  for (const m of text.matchAll(/[●•]\s*([A-Za-z_]+)/g)) states.push(m[1]!);
  const last = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).pop() ?? '';
  const lastWord = last.replace(/^["'●•\s]+|["'\s]+$/g, '');
  if (/^[A-Za-z_]+$/.test(lastWord)) states.push(lastWord);
  if (states.some((s) => DEPLOY_BAD.test(s))) return { passed: false };
  if (/successfully rolled out/i.test(last)) return { passed: true, state: 'successfully rolled out' };
  const good = states.find((s) => DEPLOY_OK.test(s));
  return good ? { passed: true, state: good } : { passed: false };
}

const POLL_OK = /^(?:ready|success|succeeded)$/i;
const POLL_BAD = /^(?:pending|failure|failed|error|errored|canceled|cancelled|queued|in_progress|building|initializing|blocked|unknown|action_required|timed_out|deploying)$/i;

/**
 * D59c: a poll loop printed a state per try; the last line that names one is where it stopped. Passed when
 * that line says READY or success and nothing pending or failed. URLs are left out (a path can hold any word).
 */
function lastPollState(text: string): { passed: boolean; state?: string } {
  const lines = text.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const tokens = lines[i]!.replace(/\bhttps?:\/\/\S+/g, ' ').split(/[^A-Za-z_]+/).filter(Boolean);
    const bad = tokens.find((t) => POLL_BAD.test(t));
    const good = tokens.find((t) => POLL_OK.test(t));
    if (bad) return { passed: false, state: bad };
    if (good) return { passed: true, state: good };
  }
  return { passed: false };
}

function checksPassed(cmd: string, text: string): boolean {
  if (/^gh pr checks/.test(cmd)) {
    const rows = text.split(/\r?\n/).filter((l) => l.includes('\t'));
    if (rows.length) return rows.every((l) => /^(?:pass|skipping|skipped|success|neutral)$/i.test(l.split('\t')[1]!.trim()));
    return /All checks were successful/i.test(text);
  }
  // Not passed: a failed, cancelled, still-running or waiting state anywhere in what it printed.
  if (/\b(?:failure|failed|cancelled|timed_out|action_required|startup_failure|in_progress|queued|pending|waiting)\b/i.test(text)) return false;
  if (/completed with '?success'?/i.test(text)) return true;
  // `--json status,conclusion`, raw or through -q/--jq: completed, with a success conclusion.
  if (/\bcompleted\b/i.test(text) && /\bsuccess\b/i.test(text)) return true;
  return /^\s*✓/m.test(text) && !/^\s*[X✗]\s/m.test(text);
}

/** A fallback that always exits 0: `echo …`, `printf …`, `true`, `:`, `exit 0`, or a group that starts with one. */
const FALLBACK = /^[({]?\s*(?:echo|printf|true|:|exit\s+0)(?![\w.-])/;

/**
 * D101: the call ends in `|| <fallback>` (`docker info || echo "docker not running"`, `npm test || true`), so its
 * exit 0 may come from the fallback alone. Such a call is never a passing check, and a run proven only by such
 * calls is not a good run. One top-level split: linear.
 */
export function fallbackOnly(cmd: string): boolean {
  const segs = splitTop(String(cmd ?? ''));
  if (segs.length < 2) return false;
  return segs[segs.length - 2]!.sep === '||' && FALLBACK.test(segs[segs.length - 1]!.text.trim());
}

/** 4.2. The `query` family only when job === 'report'. D101: never passed behind a fallback. */
export function classifyCheck(cmd: string, resultText: string, r: { failed: boolean; isError: boolean }, facts: RunFacts, job: JobClass | null): CheckHit | null {
  const hit = classifyCheckHit(cmd, resultText, r, facts, job);
  return hit && hit.passed && fallbackOnly(cmd) ? { ...hit, passed: false } : hit;
}

function classifyCheckHit(cmd: string, resultText: string, r: { failed: boolean; isError: boolean }, facts: RunFacts, job: JobClass | null): CheckHit | null {
  const hit = familyMatch(cmd, job);
  if (!hit) return null;
  const text = ends(String(resultText ?? ''));
  const ok = !r.failed;
  const { family, m } = hit;
  if (family === 'tests') {
    const t = (BATS_RE.test(m!.input) ? batsPassed(text) : null) ?? testsPassed(text, splitTop(cmd).some((seg) => seg.sep === '|'));
    return { family, passed: ok && t.passed, facts: t.count === undefined ? {} : { passedCount: t.count } };
  }
  if (family === 'npm-view') {
    const spec = m![1]!;
    const pkg = spec.replace(/(.)@.*$/, '$1');
    const known = facts.versions.find((v) => hasVersion(text, v));
    const any = !facts.versions.length && facts.published ? SEMVER.exec(text)?.[1] : undefined;
    const version = known ?? any;
    return { family, passed: ok && version !== undefined, facts: version ? { version, pkg } : { pkg } };
  }
  if (family === 'deploy' && m && isHealthCurl(m.input)) {
    // D140: a health read proves a deploy only after the run pushed or deployed.
    if (!facts.pushedBranches.length && !facts.deployed) return null;
    const up = ok && healthy(text);
    return { family, passed: up, facts: up ? { state: 'healthy' } : {} };
  }
  if (family === 'deploy' && m && m.input.startsWith('gcloud ')) {
    const g = gcloudReady(text, facts.shas);
    return { family, passed: ok && g.passed, facts: { ...(g.sha ? { sha: g.sha } : {}), ...(g.state ? { state: g.state } : {}) } };
  }
  if (family === 'deploy') {
    const d = hit.poll ? lastPollState(text) : deployState(text);
    const sha = m?.[1] ?? hit.sha;
    return { family, passed: ok && d.passed, facts: { ...(sha ? { sha } : {}), ...(d.state ? { state: d.state } : {}) } };
  }
  if (family === 'gh-checks') {
    const pr = m![1];
    return { family, passed: ok && checksPassed(m![0], text), facts: pr ? { pr } : {} };
  }
  if (family === 'push') return pushCheck(m!.input, text, ok);
  if (family === 'ls-remote') {
    const remote = m![1]!;
    const branch = m![2]!.replace(/^refs\/heads\//, '');
    const shown = [...text.matchAll(/^([0-9a-f]{7,40})\s/gm)].map((x) => x[1]!);
    const sha = facts.shas.find((s) => shown.some((o) => o.startsWith(s) || s.startsWith(o)));
    return { family, passed: ok && sha !== undefined, facts: { ...(sha ? { sha } : {}), remote, branch } };
  }
  return { family, passed: ok && !/^ERROR:/m.test(text) && text.trim() !== '', facts: {} };
}

/* --------------------------------------------- deploy status over MCP (D59b) */

/** `mcp__<server>__get_deployment` or `list_deployments` on a Vercel server (claude.ai's `claude_ai_Vercel`, a local `vercel`). */
const DEPLOY_TOOL = /^mcp__(.+)__(?:get_deployment|list_deployments)$/;

/** A deployment status tool: its result is check evidence for the deploy family, and the call is never a step (D59b). */
export function isDeployTool(name: string): boolean {
  const m = DEPLOY_TOOL.exec(String(name ?? ''));
  return m !== null && /vercel/i.test(m[1]!);
}

interface Deployment { state: string; sha?: string; branch?: string; created?: number }

const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined);

function deploymentOf(v: unknown): Deployment | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const d = v as Record<string, unknown>;
  const state = str(d.readyState) ?? str(d.state);
  if (!state) return null;
  const meta = d.meta && typeof d.meta === 'object' ? (d.meta as Record<string, unknown>) : {};
  const created = typeof d.createdAt === 'number' ? d.createdAt : typeof d.created === 'number' ? d.created : undefined;
  const sha = str(meta.githubCommitSha);
  const branch = str(meta.githubCommitRef);
  return { state, ...(sha ? { sha } : {}), ...(branch ? { branch } : {}), ...(created !== undefined ? { created } : {}) };
}

/** The deployments a result shows, newest first. JSON as the tools print it; a cut-off text read field by field. */
function deploymentsIn(text: string, list: boolean): Deployment[] {
  let j: unknown = null;
  try { j = JSON.parse(text); } catch { /* clipped or not JSON */ }
  if (j && typeof j === 'object') {
    const field = (v: unknown, k: string): unknown => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>)[k] : undefined);
    const r = field(j, 'result') ?? j;
    if (!list) return [deploymentOf(field(r, 'deployment') ?? r)].filter((d): d is Deployment => d !== null);
    const inner = field(r, 'deployments');
    const raw = [r, inner, field(inner, 'deployments')].find(Array.isArray) ?? [];
    const all = (raw as unknown[]).map(deploymentOf).filter((d): d is Deployment => d !== null);
    return all.every((d) => d.created !== undefined) ? [...all].sort((a, b) => b.created! - a.created!) : all;
  }
  const pieces = list ? text.split(/"(?:id|uid)"\s*:\s*"dpl_/).slice(1) : [text];
  const out: Deployment[] = [];
  for (const p of pieces) {
    const state = /"readyState"\s*:\s*"([A-Z_]+)"/.exec(p)?.[1] ?? /"state"\s*:\s*"([A-Z_]+)"/.exec(p)?.[1];
    const sha = /"githubCommitSha"\s*:\s*"([0-9a-f]{7,40})"/.exec(p)?.[1];
    if (state) out.push({ state, ...(sha ? { sha } : {}) });
  }
  return out;
}

/**
 * D59b: a Vercel deployment status result as a deploy check. Passed when the deployment is READY. `get_deployment`
 * reads the deployment the agent named (as `vercel inspect <url>` does). A list is Trail's pick: the newest
 * deployment, or when the run knows commits (`facts.shas`) and the list names commits, the newest at one of them
 * (READY for another commit is not this push). Any other state (BUILDING, QUEUED, INITIALIZING, ERROR, CANCELED,
 * BLOCKED) or a failed call is not a pass. Null for any other tool.
 */
export function classifyToolCheck(name: string, resultText: string, r: { failed: boolean; isError: boolean }, facts: RunFacts): CheckHit | null {
  if (!isDeployTool(name)) return null;
  const list = /__list_deployments$/.test(name);
  const deps = deploymentsIn(String(resultText ?? ''), list);
  const atCommit = (d: Deployment) => d.sha !== undefined && facts.shas.some((s) => d.sha!.startsWith(s) || s.startsWith(d.sha!));
  const d = list && facts.shas.length && deps.some((x) => x.sha) ? deps.find(atCommit) : deps[0];
  const passed = !r.failed && !r.isError && d?.state === 'READY';
  return { family: 'deploy', passed, facts: d ? { state: d.state, ...(d.sha ? { sha: d.sha } : {}), ...(d.branch ? { branch: d.branch } : {}) } : {} };
}

/** `--dry-run`, or `-n` alone or among short flags. */
const DRY_RUN = /(?:^|\s)(?:--dry-run|-[a-zA-Z]*n[a-zA-Z]*)(?=\s|$)/;
const REJECTED = /\[(?:remote )?rejected\]|^error: failed to push|^\s*!\s/m;
const isTagRef = (ref: string) => ref.startsWith('refs/tags/') || /^v?\d+\.\d+/.test(ref);

/** The remote a `git push` names: its first word after `push` that is not a flag or a flag's value. */
function pushRemote(bare: string): string | undefined {
  const args = bare.replace(/^.*?\bpush\b/, '').trim().split(/\s+/).filter(Boolean);
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '-o' || a === '--push-option' || a === '--repo' || a === '--receive-pack' || a === '--exec') { i++; continue; }
    if (!a.startsWith('-')) return a.replace(/^['"]|['"]$/g, '');
  }
  return undefined;
}

/**
 * D56a: a push passed when it ran (exit 0), was not a dry run, printed a branch ref that moved
 * (`<old>..<new>  <src> -> <dst>`, `<old>...<new>` forced, or `* [new branch]`), and nothing was rejected.
 * "Everything up-to-date" moved nothing; a tag alone moves no branch.
 */
function pushCheck(bare: string, text: string, ok: boolean): CheckHit {
  const remote = pushRemote(bare);
  const moved = [...text.matchAll(PUSH_TAIL)].filter((m) => !isTagRef(m[4]!.replace(/^refs\/heads\//, '')));
  const last = moved[moved.length - 1];
  const facts: CheckHit['facts'] = {};
  if (last?.[2]) facts.sha = last[2];
  if (last) facts.branch = last[4]!.replace(/^refs\/heads\//, '');
  if (remote) facts.remote = remote;
  const passed = ok && moved.length > 0 && !DRY_RUN.test(bare.replace(/^.*?\bpush\b/, '')) && !REJECTED.test(text) && !/Everything up-to-date/.test(text);
  return { family: 'push', passed, facts };
}

const SHA = /^[0-9a-f]{7,40}$/;
const isSha = (t: string) => SHA.test(t) && /\d/.test(t) && /[a-f]/.test(t);
const addOnce = (list: string[], v: string | undefined) => { if (v && !list.includes(v)) list.push(v); };
const PUSH_TAIL = /^\s*[+*=!-]?\s*(?:([0-9a-f]{7,40})\.\.\.?([0-9a-f]{7,40})|\[new branch\])\s+(\S+)\s+->\s+(\S+)/gm;

/** Branches and shas a `git push` command names. */
function pushTargets(bare: string, facts: RunFacts): void {
  const args = bare.split(/\s+/).slice(2);
  const pos: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '-o' || a === '--push-option' || a === '--repo') { i++; continue; }
    if (!a.startsWith('-')) pos.push(a.replace(/^['"]|['"]$/g, ''));
  }
  for (const spec of pos.slice(1)) {
    const [src, dst] = spec.replace(/^\+/, '').split(':') as [string, string | undefined];
    if (isSha(src)) addOnce(facts.shas, src);
    const target = (dst ?? src).replace(/^refs\/heads\//, '');
    if (!target || target === 'HEAD' || target.startsWith('refs/') || /^v?\d+\.\d+/.test(target) || isSha(target)) continue;
    addOnce(facts.pushedBranches, target);
  }
}

export function factsFromCalls(calls: RunCall[], prompt: PromptParams): RunFacts {
  const facts: RunFacts = { versions: [], shas: [], pushedBranches: [], published: false };
  for (const c of calls) {
    const cmd = callText(c);
    if (!cmd || c.failed) continue;
    for (const simple of simpleCommands(stripOutputFilters(cmd))) {
      const bare = bareCommand(simple);
      if (/^(?:npm|pnpm|yarn(?: npm)?) publish\b/.test(bare)) {
        facts.published = true;
        addOnce(facts.versions, /-(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)\.tgz\b/.exec(bare)?.[1]);
      }
      if (/^npm version\b/.test(bare)) addOnce(facts.versions, /^npm version (?:-\S+\s+)*v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)\b/.exec(bare)?.[1]);
      if (/^git push\b/.test(bare)) pushTargets(bare, facts);
      if (DEPLOY_STEP.test(bare)) facts.deployed = true;
      if (/^git rev-parse\b/.test(bare)) for (const t of (c.tail ?? '').split(/\s+/)) if (isSha(t)) addOnce(facts.shas, t);
      for (const m of bare.matchAll(/\bcommits\/([0-9a-f]{7,40})\b/g)) addOnce(facts.shas, m[1]);
      const pr = /^gh pr \w+ #?(\d+)\b/.exec(bare)?.[1];
      if (pr) facts.pr = pr;
    }
    const tail = c.tail ?? '';
    for (const m of tail.matchAll(/^\+ (@?[\w./-]+)@(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)\s*$/gm)) addOnce(facts.versions, m[2]);
    if (/\bgit push\b/.test(cmd)) {
      for (const m of tail.matchAll(PUSH_TAIL)) {
        addOnce(facts.shas, m[2]);
        const dst = m[4]!.replace(/^refs\/heads\//, '');
        if (!/^v?\d+\.\d+/.test(dst) && !dst.startsWith('refs/')) addOnce(facts.pushedBranches, dst);
      }
    }
  }
  addOnce(facts.versions, prompt.version);
  return facts;
}

/** The last paragraph of prose, code blocks removed, at most 300 characters. */
function lastWords(text: string): string {
  const prose = String(text ?? '').replace(/```[\s\S]*?(?:```|$)/g, '\n\n');
  const para = prose.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean).pop() ?? '';
  return para.slice(-300);
}

const QUESTION = /\b(should I|shall I|do you want|would you like|want me to|let me know (if|when|whether)|can you (tap|confirm|run|approve|check|sign in)|please (tap|confirm|run|approve|check|sign in|let me know)|waiting (for|on) you|once you('ve| have)?)\b/i;
const NEGATED = /\b(0|no|zero|none of the|nothing) (\w+ ){0,2}(fail\w*|error\w*)/gi;
const FAILURE = /\b(failed|fails|failing|couldn'?t|could not|can'?t|cannot|unable to|blocked|didn'?t (work|finish|go through)|not (yet )?(published|deployed|live|green|passing)|still (red|broken|pending|failing)|errored|timed out)\b/i;

/** 4.3, on the last assistant message of the turn. */
export function endsInQuestion(assistantText: string): boolean {
  const p = lastWords(assistantText);
  if (!p) return false;
  const lastLine = p.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).pop() ?? '';
  return /\?$/.test(lastLine.replace(/[)*"\s]+$/, '')) || QUESTION.test(p);
}

export function endsInFailure(assistantText: string): boolean {
  return FAILURE.test(lastWords(assistantText).replace(NEGATED, ' '));
}
