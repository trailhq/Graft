/**
 * Which Trail workspace a repo's team uses: `.trail/workspace.json`,
 * committed with the rest of `.trail/`.
 *
 * A signed-in laptop writes it when it syncs the repo into the workspace.
 * A teammate who pulls it and isn't signed in is then offered the sign-in
 * once (the MCP instructions say so), and `trail login` in that repo picks
 * that workspace on the page. One file, three fields, no token: it only says
 * where the team is.
 *
 * The address in it is only trusted when it is the Trail this laptop would
 * sign in to anyway: a repo can't send someone to sign in somewhere else.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { readJson, writeJsonAtomic } from "../util/state.js";
import { trailOnPath } from "../brand.js";
import { repoPlace } from "../notes/home.js";
import { readClouds, serverUrl, trailUrl, type Cloud } from "./workspace.js";

export interface TeamFile {
  /** The Trail the workspace is on. */
  trail: string;
  /** Its slug, which `/connect?ws=` takes. */
  workspace: string;
  /** Its name, for the line that offers the sign-in. */
  name: string;
}

const SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;

function teamPath(checkout: string): string {
  return join(checkout, ".trail", "workspace.json");
}

/** The file as written, or null when it's missing or not one. */
export function readTeamFile(checkout: string): TeamFile | null {
  const f = readJson<Partial<TeamFile>>(teamPath(checkout));
  const trail = serverUrl(typeof f?.trail === "string" ? f.trail : undefined);
  if (!f || !trail || typeof f.workspace !== "string" || !SLUG.test(f.workspace)) return null;
  const name = typeof f.name === "string" ? f.name.replace(/\s+/g, " ").trim().slice(0, 80) : "";
  return { trail, workspace: f.workspace, name: name || f.workspace };
}

/** The repo's workspace, when it is on the Trail this laptop signs in to. */
export function teamWorkspace(checkout: string, env: NodeJS.ProcessEnv = process.env): TeamFile | null {
  const f = readTeamFile(checkout);
  return f && f.trail === trailUrl(env) ? f : null;
}

/**
 * Say in the repo which workspace it's in. Only in a repo that already keeps
 * `.trail/`, and only when what it says changed. Best effort.
 */
export function writeTeamFile(checkout: string, cloud: Pick<Cloud, "url" | "workspace">): boolean {
  try {
    const trail = serverUrl(cloud.url);
    if (!trail || !existsSync(join(checkout, ".trail")) || !SLUG.test(cloud.workspace.slug)) return false;
    const next: TeamFile = { trail, workspace: cloud.workspace.slug, name: cloud.workspace.name };
    const now = readTeamFile(checkout);
    if (now && now.trail === next.trail && now.workspace === next.workspace && now.name === next.name) return false;
    writeJsonAtomic(teamPath(checkout), next);
    return true;
  } catch {
    return false;
  }
}

/** Said in a repo whose team uses a Trail workspace, on a laptop not signed in to it. */
export function teamLine(name: string, slug: string, installed = trailOnPath()): string {
  // Without trail on this laptop, npx runs the same sign-in, and it sets up the agents after.
  const login = `${installed ? "trail" : "npx -y @trailhq/trail-code@latest"} login --workspace ${slug}`;
  return `This repo's team uses Trail: their workspace ${name} has the team's brand, skills and learnings, and this laptop isn't signed in to it. Once, at the end of your first reply, or when the user asks for something those would help with (a deck, a doc in the team's voice), run \`${login}\` and give the user the link it prints. One click in their browser signs this laptop in; then the workspace's tools show up here.`;
}

/** The same line for a Claude Code session in `dir`: only when this laptop isn't signed in to that team's workspace. Never throws. */
export function teamSignInLine(dir: string, env: NodeJS.ProcessEnv = process.env): string {
  try {
    const team = teamWorkspace(repoPlace(dir, env).checkout, env);
    if (!team || readClouds(env).some((c) => c.workspace.slug === team.workspace)) return "";
    return teamLine(team.name, team.workspace);
  } catch {
    return "";
  }
}
