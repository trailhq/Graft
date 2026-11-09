/**
 * `trail init --pair CODE`: the setup prompt a person copied from Trail's
 * onboarding page carries a pair code. With it, init tells Trail about itself
 * before doing anything slow, so the page the person is on moves on to sign-up
 * at once; then it streams what it's doing (the map, the PRs, past sessions,
 * the learnings it wrote) to the page that shows it live, and hands over what
 * it found for the person to review there.
 *
 * Nothing goes up as a workspace learning from here. The person keeps or drops
 * each one on the review page, and Trail stores that. A detached
 * `_trail-pair` child then waits for the connection, saves it, waits for the
 * review, and uploads the repo the usual way, which leaves a dropped learning
 * dropped.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { graftCliPath } from "../claude/paths.js";
import { noteAuthor } from "../notes/git-facts.js";
import { repoName, repoPlace } from "../notes/home.js";
import type { FoundSkill } from "../init/run.js";
import type { LiveLearning } from "../init/live.js";
import { skillName } from "../skills/skills.js";
import { newState, pairSettled, PAIR_WAIT_MS, rememberPair } from "./nudge.js";
import type { TeammateSummary, TokensSummary } from "./onboarding.js";
import { dropActivity, reviewPayload, syncRepo } from "./workspace-sync.js";
import { machinePayload, otherRepos, setUpPicked, type OtherRepo } from "./other-repos.js";
import { claimHandoff, cloudForRepo, fetchMe, isError, postHandoffProgress, readCloud, readClouds, registerHandoff, sendMachineRepos, trailUrl, writeCloud, type Cloud, type SetupFailure } from "./workspace.js";

/** A pair code as the onboarding page prints it: letters and digits. */
export function validPairCode(code: string): boolean {
  return /^[A-Za-z0-9-]{6,64}$/.test(code.trim());
}

export type PhaseId = "install" | "files" | "tokens" | "prs" | "decisions" | "team" | "learnings";
type PhaseStatus = "todo" | "running" | "done";
interface Phase {
  id: PhaseId;
  label: string;
  status: PhaseStatus;
  count: string;
}

/**
 * What init found out beyond the learnings, for the onboarding page: one
 * lookup's token saving, the sessions read, teammates' branches on this
 * person's files, and the agents set up here. An empty `teammates` list means
 * "checked, none".
 */
export interface PairFindings {
  tokens?: TokensSummary | null;
  sessions?: number;
  teammates?: TeammateSummary[];
  /** `--agents auto`: the agents set up and working on this laptop, the one running init first ("claude", "cursor", "codex", ...). */
  agents?: string[];
}

/**
 * A skill the look-back found, as a found item: its title and on how many
 * days it came up, labelled kept on this machine. Never its steps: init's
 * skills are the person's own (they go to ~/.trail, and only when kept
 * through `trail keep` or the screen), so the page names them and
 * nothing more. Its path is not a repo path, so it can't be taken for one of
 * the repo's skills.
 */
function machineSkillItem(s: FoundSkill, author: string): Record<string, unknown>[] {
  const name = skillName(s.name);
  const title = s.title.replace(/\s+/g, " ").trim().slice(0, 120);
  if (!name || !title) return [];
  const days = Math.max(0, Math.floor(s.days));
  return [
    {
      kind: "skill",
      path: `~/.trail/skills/${name}`,
      title,
      why: `kept on this machine · came up on ${days} day${days === 1 ? "" : "s"}`,
      author,
      body: "",
      hash: createHash("sha256").update(`machine-skill:${s.id}`).digest("hex"),
      touches: [],
    },
  ];
}

/**
 * "Found 3 learnings and 1 skill for your team"; the skills part is left out
 * when there are none. Skills kept on this machine are counted apart: they
 * aren't the team's.
 */
export function foundLine(learnings: number, skills: number, mine = 0): string {
  const l = `${learnings} learning${learnings === 1 ? "" : "s"}`;
  const sk = `${skills} skill${skills === 1 ? "" : "s"}`;
  const team = `Found ${learnings === 0 && skills > 0 ? sk : skills > 0 ? `${l} and ${sk}` : l} for your team`;
  return mine > 0 ? `${team}, and ${mine} skill${mine === 1 ? "" : "s"} kept on this machine` : team;
}

/** The most found learnings one progress call may carry. */
const FOUND_PER_CALL = 200;
/** The most found items Trail keeps from one read. */
const MAX_FOUND = 500;

/**
 * One init run, reported to the onboarding page. Every call after start is
 * best effort: a slow or unreachable Trail never holds up or fails init. A
 * Trail that can't be reached at start does stop init (see runInitCommand).
 */
export class PairRun {
  readonly state: string;
  readonly url: string;
  private readonly base: string;
  private phases: Phase[];
  private chain: Promise<unknown> = Promise.resolve();
  private readonly fetchImpl?: typeof fetch;
  /** Trail said it takes learnings while init reads, and puts the final list in their place (`live_found`). */
  private readonly live: boolean;

  private constructor(base: string, state: string, url: string, version: string, fetchImpl?: typeof fetch, live = false) {
    this.base = base;
    this.live = live;
    this.fetchImpl = fetchImpl;
    this.state = state;
    this.url = url;
    this.phases = [
      { id: "install", label: "Install Trail-code", status: "done", count: version },
      { id: "files", label: "Map the code", status: "todo", count: "" },
      { id: "tokens", label: "Measure one lookup", status: "todo", count: "" },
      { id: "prs", label: "Read pull requests", status: "todo", count: "" },
      { id: "decisions", label: "Read past Claude sessions", status: "todo", count: "" },
      { id: "team", label: "Check your team's branches", status: "todo", count: "" },
      { id: "learnings", label: "Write learnings", status: "todo", count: "" },
    ];
  }

  /**
   * Tell Trail about this run, with the pair code, and return it; an error
   * when Trail turns it down (with its status) or can't be reached (none).
   */
  static async start(repo: string, code: string, opts: { agent: string; version: string; fetchImpl?: typeof fetch }): Promise<PairRun | { error: string; status?: number }> {
    const base = trailUrl();
    const state = newState();
    const place = repoPlace(repo);
    const current = place.git ? { key: place.key, name: repoName(place.key, place.checkout) } : null;
    // This repo only, with the learnings it already has: nobody has signed in
    // yet, so nothing tells Trail what else is on this machine.
    const here = place.git ? reviewPayload(place.checkout).filter((l) => l.ref === "" && l.kind !== "skill").length : 0;
    const known = current ? [{ ...current, learnings: here }] : [];
    const reg = await registerHandoff(
      base,
      { state, repo: current, repos: known, author: noteAuthor(repo), pair: code.trim().toUpperCase() },
      opts.fetchImpl,
    );
    if (isError(reg)) return { error: reg.error, status: reg.status };
    const run = new PairRun(base, state, reg.url, opts.version, opts.fetchImpl, reg.features?.includes("live_found") === true);
    run.send({ agent: opts.agent, phases: run.phases, log: [`Installed Trail-code ${opts.version}`] });
    return run;
  }

  /** Move a step on: running, or done with what it counted. */
  phase(id: PhaseId, status: PhaseStatus, count = "", log?: string): void {
    this.phases = this.phases.map((p) => (p.id === id ? { ...p, status, count: count || p.count } : p));
    this.send({ phases: this.phases, ...(log ? { log: [log] } : {}) });
  }

  /**
   * One learning a read just checked, for the page to show while init reads.
   * Only to a Trail that takes them: it puts the final list in their place at
   * {@link finish}, so one dropped later (a duplicate, or not about this
   * code) never reaches the review. Its path is its own, not a file's.
   */
  learning(l: LiveLearning, author: string): void {
    if (!this.live) return;
    const hash = createHash("sha256").update(`live:${l.title}\n${l.body}`).digest("hex");
    this.send({ found: [{ kind: "decision", path: `live/${hash.slice(0, 16)}`, title: l.title, author, body: l.body, hash, touches: [] }] });
  }

  /** The token step's end: the saving is an estimate (the pack against reading the files whole), and the page says so. */
  tokensDone(tokens: TokensSummary | null): void {
    this.phase(
      "tokens",
      "done",
      tokens ? `~${tokens.pct}% fewer tokens` : "skipped",
      tokens
        ? `${tokens.pr ? `Your last PR, #${tokens.pr.number}: one` : "One"} lookup used ~${tokens.pct}% fewer tokens than reading ${tokens.files} file${tokens.files === 1 ? "" : "s"} (estimate)`
        : undefined,
    );
  }

  /** The team step's end: `undefined` teammates means nothing was checked (no origin remote), not "none". */
  teamDone(teammates: TeammateSummary[] | undefined): void {
    if (teammates) this.phase("team", "done", `${teammates.length} ${teammates.length === 1 ? "person" : "people"}`);
    else this.phase("team", "done", "skipped", "No origin remote, so no teammates' branches to check");
  }

  /** Send what init found beyond the learnings; keys left undefined (or a null `tokens`) are left out. */
  findings(f: PairFindings): void {
    const out: Record<string, unknown> = {};
    if (f.tokens) out.tokens = f.tokens;
    if (f.sessions !== undefined) out.sessions = f.sessions;
    if (f.teammates !== undefined) out.teammates = f.teammates;
    if (f.agents !== undefined) out.agents = f.agents;
    this.send({ findings: out });
  }

  /**
   * Hand over the repo's learnings and skills, then say the read is done. A
   * learning is a `decision`; a skill is a `skill`. The skills the look-back
   * found (`found`) go last, by title and day count only, labelled kept on
   * this machine: a pick on the page saves nothing here.
   */
  finish(repo: string, found: FoundSkill[] = []): Promise<void> {
    const place = repoPlace(repo);
    // Everything the person's agents now start from in this repo, so the page
    // counts what the home will: their learnings and teammates' pushed ones,
    // and the skills the repo has. Then the skills found on this machine.
    const items: Record<string, unknown>[] = [];
    if (place.git) {
      const payload = reviewPayload(place.checkout);
      const item = (l: (typeof payload)[number]) => ({
        kind: l.kind === "skill" ? "skill" : "decision", path: l.path, title: l.title, author: l.author, body: l.body, hash: l.hash, touches: l.touches,
        // A skill's description is what the page and Claude read to pick it; the review saves what it's given.
        ...(l.why ? { why: l.why } : {}),
      });
      items.push(...payload.filter((l) => l.kind !== "skill").map(item), ...payload.filter((l) => l.kind === "skill").map(item));
    }
    const author = noteAuthor(repo);
    const mine = found.flatMap((s) => machineSkillItem(s, author));
    items.splice(MAX_FOUND - Math.min(mine.length, MAX_FOUND));
    items.push(...mine);
    items.splice(MAX_FOUND); // Trail takes this many from one read
    const n = items.length;
    const machine = Math.min(mine.length, MAX_FOUND);
    const m = items.filter((f) => f.kind === "skill").length - machine;
    const learned = n - m - machine;
    this.phases = this.phases.map((p) => (p.status === "done" ? p : { ...p, status: "done" as const }));
    this.phases = this.phases.map((p) => (p.id === "learnings" ? { ...p, count: String(n) } : p));
    for (let i = 0; i < Math.max(n, 1); i += FOUND_PER_CALL) {
      const part = items.slice(i, i + FOUND_PER_CALL);
      // The first part replaces what was shown while reading, on a Trail that took those.
      this.send({ phases: this.phases, found: part, ...(i === 0 ? { log: [foundLine(learned, m, machine)], ...(this.live ? { replaceFound: true } : {}) } : {}) });
    }
    this.send({ done: true });
    return this.flush();
  }

  /** Say the run stopped and why, after every report so far: the page shows it instead of waiting. */
  fail(reason: SetupFailure): Promise<void> {
    this.send({ failed: reason });
    return this.flush();
  }

  /** Wait for every report so far to be sent (or to fail). */
  flush(): Promise<void> {
    return this.chain.then(() => undefined);
  }

  /** Start the detached wait for the connection and the review, at the Trail this run reported to. */
  handOff(repo: string): void {
    const child = spawn(process.execPath, [graftCliPath(), "_trail-pair", this.state, repo, this.base], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.unref();
    rememberPair(this.state, repo, this.base, undefined, Date.now(), child.pid);
  }

  private send(body: Record<string, unknown>): void {
    // One after another, so the page sees the steps in order.
    this.chain = this.chain.then(() => postHandoffProgress(this.base, { state: this.state, ...body }, this.fetchImpl)).catch(() => undefined);
  }
}

export interface FinishOptions {
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** How long to wait for the person, all told. */
  waitMs?: number;
  /** The laptop's other repos to offer; found from Claude Code's sessions by default. */
  otherRepos?: (exceptKey: string) => OtherRepo[];
  /** Sets up a picked repo's agents and map; `trail init --yes` by default. */
  initRepo?: (checkout: string) => Promise<boolean>;
  /** A later command's wait, after the first one ran out: the command after it says the machine connected. */
  resumed?: boolean;
}
/** Once the review is in, how much longer to wait for a pick of the other repos. */
const PICK_AFTER_REVIEW_MS = 10 * 60 * 1000;

/**
 * What `_trail-pair` runs: wait for the person to connect in the browser, save
 * the connection, wait for their review, then upload this repo's learnings.
 * Returns what happened, for tests.
 */
export async function finishPair(state: string, repo: string, opts: FinishOptions = {}): Promise<"uploaded" | "expired" | "timed_out" | "failed"> {
  const { outcome, learnings } = await waitAndUpload(state, repo, opts);
  const now = (opts.now ?? Date.now)();
  if (outcome === "timed_out") pairSettled(state, "timed_out", undefined, undefined, now);
  else if (outcome !== "uploaded" || !opts.resumed) pairSettled(state, "over", undefined, undefined, now);
  else {
    // Nobody was watching this one connect: the next command says so.
    const cloud = cloudForRepo(repoPlace(repo).key) ?? readCloud();
    pairSettled(state, "linked", cloud ? { workspace: cloud.workspace.name, url: cloud.workspace.url, repos: cloud.repos.length, learnings } : undefined, undefined, now);
  }
  return outcome;
}

type Waited = { outcome: "uploaded" | "expired" | "timed_out" | "failed"; learnings: number };

async function waitAndUpload(state: string, repo: string, opts: FinishOptions): Promise<Waited> {
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const started = now();
  const late = () => now() - started >= (opts.waitMs ?? PAIR_WAIT_MS);
  const base = trailUrl();

  let cloud: Cloud | null = null;
  for (;;) {
    const got = await claimHandoff(base, state, opts.fetchImpl);
    if ("cloud" in got) {
      cloud = { ...got.cloud, url: base, linkedAt: now() };
      // Like any first connect: nothing recorded before it goes up. A later
      // one keeps what the workspaces already here have waiting.
      if (!readClouds().length) dropActivity();
      writeCloud(cloud);
      break;
    }
    if ("error" in got) return { outcome: "expired", learnings: 0 };
    if (late()) return { outcome: "timed_out", learnings: 0 };
    await sleep(1500);
  }

  // The laptop's other repos go to the page by name; the ones the person
  // picks are set up while they carry on, alongside the review below.
  const place = repoPlace(repo);
  const others = (opts.otherRepos ?? otherRepos)(place.key);
  const offered = await sendMachineRepos(cloud, state, machinePayload(others), opts.fetchImpl);
  let reviewedAt = 0;
  const pickLate = () => late() || (reviewedAt > 0 && now() - reviewedAt >= PICK_AFTER_REVIEW_MS);
  const extra = !isError(offered) && others.length
    ? setUpPicked(cloud, state, others, { fetchImpl: opts.fetchImpl, sleep, late: pickLate, initRepo: opts.initRepo }).catch(() => [] as string[])
    : Promise.resolve([] as string[]);

  // Trail turns progress away once the review is in: that's the signal.
  for (;;) {
    const r = await postHandoffProgress(base, { state }, opts.fetchImpl);
    if (r === "reviewed") {
      reviewedAt = now();
      break;
    }
    if (r === "gone") return { outcome: "expired", learnings: 0 };
    if (late()) return { outcome: "timed_out", learnings: 0 };
    await sleep(2000);
  }

  // The review added this repo to the workspace; pick that up, then upload.
  const me = await fetchMe(cloud, opts.fetchImpl);
  if (!isError(me)) {
    cloud = { ...cloud, user: me.user, workspace: me.workspace, repos: me.repos.map((r) => r.key) };
    writeCloud(cloud);
  }
  const res = place.git ? await syncRepo(place.checkout, readCloud() ?? cloud, { fetch: false, fetchImpl: opts.fetchImpl }) : null;
  // The picked repos joined the workspace too: save them with the rest.
  if ((await extra).length) {
    const after = await fetchMe(cloud, opts.fetchImpl);
    if (!isError(after)) writeCloud({ ...(readCloud() ?? cloud), repos: after.repos.map((r) => r.key) });
  }
  return res && isError(res) ? { outcome: "failed", learnings: 0 } : { outcome: "uploaded", learnings: res?.learnings ?? 0 };
}
