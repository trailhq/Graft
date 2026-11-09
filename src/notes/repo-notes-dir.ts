/**
 * A repo's personal learnings folder from its key, under the Trail home
 * (`<trail home>/repos/<key>/notes`, phase 0's layout), for code that has a
 * repo key but no checkout (b3's wall lessons). Every part of the key must be
 * a plain folder name, so a key can't walk out of `repos/`.
 */
import { trailPath } from "../util/private-fs.js";
import { flatLine } from "./flatten.js";

export function repoNotesDir(repoKey: string, env?: NodeJS.ProcessEnv): string {
  const parts = String(repoKey ?? "").split("/");
  if (!parts.length || parts.some((p) => !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(p) || p.includes(".."))) {
    throw new Error(`trail: not a repo key: ${flatLine(repoKey, 60)}`);
  }
  return trailPath(env, "repos", ...parts, "notes");
}
