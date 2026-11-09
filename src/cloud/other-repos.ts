/**
 * The other repos on this laptop, for one install to reach all of them. After
 * the first repo is connected, Trail's onboarding page lists the repos Claude
 * Code ran in here (their names only, never their paths), the person ticks the
 * ones they want, and this sets each one up the way the first was: agents
 * wired, the map built, the repo added to the workspace and its learnings
 * synced. Only places Claude Code already ran in, or Trail already knows, are
 * looked at: nothing searches the disk.
 */
import { spawn } from "node:child_process";
import { existsSync, lstatSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { graftCliPath } from "../claude/paths.js";
import { firstCwd } from "../init/transcript.js";
import { knownRepos, remoteKey, repoName } from "../notes/home.js";
import { syncRepo } from "./workspace-sync.js";
import { addRepo, fetchMachinePicks, isError, postRepoSetup, type Cloud } from "./workspace.js";

/** At most this many go to the page, most recently used first. */
export const OTHER_REPOS_MAX = 15;

export interface OtherRepo {
  key: string;
  name: string;
  /** The checkout to set up; stays on this laptop. */
  checkout: string;
  /** When Claude Code (or Trail) last ran there, in ms; 0 when unknown. */
  lastUsed: number;
  /** Claude Code sessions run there. */
  sessions: number;
}

/**
 * Repos with a remote that Claude Code ran in (by each project folder's first
 * transcript) or Trail ran in, besides `exceptKey`, deduped by remote.
 */
export function otherRepos(exceptKey: string, home: string = homedir(), env: NodeJS.ProcessEnv = process.env): OtherRepo[] {
  const byKey = new Map<string, OtherRepo>();
  const add = (cwd: string, lastUsed: number, sessions: number) => {
    if (!cwd || cwd === home || !existsSync(cwd)) return;
    const found = remoteKey(cwd);
    if (!found || found.key === exceptKey) return;
    const had = byKey.get(found.key);
    if (!had) {
      byKey.set(found.key, { key: found.key, name: repoName(found.key, found.checkout), checkout: found.checkout, lastUsed, sessions });
      return;
    }
    had.sessions += sessions;
    if (lastUsed > had.lastUsed) Object.assign(had, { lastUsed, checkout: found.checkout });
  };

  const projects = join(home, ".claude", "projects");
  let folders: string[] = [];
  try {
    folders = readdirSync(projects);
  } catch {
    /* no Claude Code here */
  }
  for (const folder of folders) {
    const dir = join(projects, folder);
    let files: { name: string; mtimeMs: number }[];
    try {
      // A linked folder can bring in someone else's sessions: left out, as init does.
      if (!lstatSync(dir).isDirectory()) continue;
      files = readdirSync(dir)
        .filter((f) => f.endsWith(".jsonl"))
        .map((name) => ({ name, st: lstatSync(join(dir, name)) }))
        .filter((f) => f.st.isFile())
        .map((f) => ({ name: f.name, mtimeMs: f.st.mtimeMs }));
    } catch {
      continue;
    }
    if (!files.length) continue;
    files.sort((a, b) => a.name.localeCompare(b.name));
    const cwd = firstCwd(join(dir, files[0].name));
    if (cwd) add(cwd, Math.max(...files.map((f) => f.mtimeMs)), files.length);
  }
  for (const r of knownRepos(env)) if (r.path) add(r.path, r.seenAt, 0);

  return [...byKey.values()].sort((a, b) => b.lastUsed - a.lastUsed).slice(0, OTHER_REPOS_MAX);
}

/** What the page gets: names and counts only. */
export function machinePayload(repos: OtherRepo[]): { key: string; name: string; last_used?: string; sessions: number }[] {
  return repos.map((r) => ({ key: r.key, name: r.name, sessions: r.sessions, ...(r.lastUsed ? { last_used: new Date(r.lastUsed).toISOString() } : {}) }));
}

export interface SetupOptions {
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /** Stop waiting for the person's pick. */
  late: () => boolean;
  /** Wires agents and builds the map in a checkout; `trail init --yes` by default. */
  initRepo?: (checkout: string) => Promise<boolean>;
}

/**
 * Wait for the person to pick, then set each picked repo up in turn, saying
 * how each goes. Returns the keys that are now in the workspace.
 */
export async function setUpPicked(cloud: Cloud, state: string, repos: OtherRepo[], opts: SetupOptions): Promise<string[]> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let picks: string[] | null = null;
  for (;;) {
    const got = await fetchMachinePicks(cloud, state, opts.fetchImpl);
    if (!isError(got) && got.picks) {
      picks = got.picks;
      break;
    }
    if (isError(got) && got.status === 404) return [];
    if (opts.late()) return [];
    await sleep(2000);
  }

  const added: string[] = [];
  let repoKeys = [...cloud.repos];
  for (const key of picks) {
    const r = repos.find((x) => x.key === key);
    if (!r) continue;
    await postRepoSetup(cloud, state, key, "setting_up", 0, opts.fetchImpl);
    let learnings = -1;
    if (await (opts.initRepo ?? initRepo)(r.checkout)) {
      const res = await addRepo(cloud, { key: r.key, name: r.name }, opts.fetchImpl);
      if (!isError(res)) {
        repoKeys = [...new Set([...repoKeys, ...res.repos.map((x) => x.key)])];
        const synced = await syncRepo(r.checkout, { ...cloud, repos: repoKeys }, { fetch: false, fetchImpl: opts.fetchImpl });
        if (!isError(synced)) learnings = synced.learnings;
      }
    }
    if (learnings >= 0) added.push(key);
    await postRepoSetup(cloud, state, key, learnings >= 0 ? "done" : "failed", Math.max(learnings, 0), opts.fetchImpl);
  }
  return added;
}

/** `trail init --yes` in the checkout, quietly, without reading past sessions again. */
function initRepo(checkout: string): Promise<boolean> {
  return new Promise((done) => {
    const child = spawn(process.execPath, [graftCliPath(), "init", checkout, "--yes", "--plain"], {
      cwd: checkout,
      stdio: "ignore",
      windowsHide: true,
      env: { ...process.env, TRAIL_NO_LOOK_BACK: "1" },
    });
    child.on("error", () => done(false));
    child.on("exit", (code) => done(code === 0));
  });
}
