/**
 * A coding agent using one of the repo's skills, as a run on the workspace.
 * Claude Code loads a skill itself (the `Skill` tool, or the person typing
 * `/name`), so without this the workspace only hears of runs that went
 * through its own connector, and a skill the team runs every day reads as
 * "Not used yet". Only the skill's name goes: never the task, the prompt or
 * the arguments. Only a skill the repo keeps in `.claude/skills/<name>/`
 * counts (a personal or plugin skill is not the team's), and only once the
 * workspace has it (flushActivity drops the rest).
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { payloadSessionId } from "./hook-io.js";
import { readSession, writeSession } from "./state.js";
import { repoPlace } from "../notes/home.js";
import { noteAuthor } from "../notes/git-facts.js";
import { cloudIn, readClouds, type Cloud } from "../cloud/workspace.js";
import { recordActivity, records } from "../cloud/workspace-sync.js";

/** The same skill again within this long in one session is the same run (the person typed `/name`, then the agent loaded it). */
export const SAME_RUN_MS = 2 * 60_000;

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** The skill a `Skill` tool call loaded, or "" for any other call. A plugin's (`plugin:name`) is not a repo's. */
export function skillOfToolUse(input: any): string {
  if (input?.tool_name !== "Skill") return "";
  const raw = input?.tool_input?.skill ?? input?.tool_input?.command;
  const name = typeof raw === "string" ? raw.trim().replace(/^\//, "") : "";
  return NAME.test(name) ? name : "";
}

/** The skill a prompt calls by `/name`, or "". */
export function skillOfPrompt(prompt: unknown): string {
  const m = typeof prompt === "string" ? /^\s*\/([A-Za-z0-9][A-Za-z0-9._-]{0,63})(?:\s|$)/.exec(prompt) : null;
  return m ? m[1]! : "";
}

/**
 * Queue a run of `name` when it is one of this repo's skills and the machine
 * records uses for the repo. Never throws.
 */
export function recordSkillUse(name: string, input: unknown, dir: string, opts: { cloud?: Cloud | null; now?: number } = {}): boolean {
  // Most tool calls and prompts aren't a skill: they stop here, before any file is read.
  if (!name) return false;
  try {
    const clouds = opts.cloud === undefined ? readClouds() : opts.cloud ? [opts.cloud] : [];
    const now = opts.now ?? Date.now();
    if (!clouds.length) return false;
    const place = repoPlace(dir);
    const cloud = cloudIn(clouds, place.key);
    if (!records(cloud, place.key)) return false;
    if (!existsSync(join(place.checkout, ".claude", "skills", name, "SKILL.md"))) return false;
    const session = payloadSessionId(input);
    const s = readSession(dir, session);
    const seen = s.skillsUsed ?? {};
    if (now - (seen[name] ?? 0) < SAME_RUN_MS) return false;
    writeSession(dir, session, { ...s, skillsUsed: { ...seen, [name]: now } });
    const me = noteAuthor(place.checkout);
    recordActivity(
      {
        repo: place.key,
        kind: "skill",
        skill: name,
        asker: me,
        session,
        file_count: 0,
        shown_paths: [],
        shown_authors: [],
        at: new Date(now).toISOString(),
      },
      cloud,
    );
    return true;
  } catch {
    // A lost run undercounts the skill by one.
    return false;
  }
}
