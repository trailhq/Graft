/**
 * Builders for the store tests: a sandbox Trail home and person home, and a
 * compiled skill shaped like compile's output (made-up repos acme/shop and
 * acme/storefront). Not a test file itself.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpRepo } from "./helpers.js";
import type { CompiledSkill, SkillMeta } from "../src/skills/types.js";
import { renderSkillMd } from "../src/skills/skillmd.js";

export const SHOP = "github.com/acme/shop";
export const STOREFRONT = "github.com/acme/storefront";

export interface Box { env: NodeJS.ProcessEnv; trail: string; home: string; checkout: string }

/** TRAIL_HOME and HOME of its own (a test home), and a checkout folder for acme/shop. */
export function box(tag = "store"): Box {
  const home = tmpRepo(tag);
  const trail = join(home, "trail-home");
  const checkout = join(home, "src", "shop");
  mkdirSync(checkout, { recursive: true });
  return { env: { HOME: home, TRAIL_HOME: trail }, trail, home, checkout };
}

export function compiled(name = "release-npm", meta: Partial<SkillMeta> = {}, extra: Partial<CompiledSkill> = {}): CompiledSkill {
  return {
    name,
    title: "Release acme-cli to npm",
    description: "Publishes acme-cli to npm from the steps that worked on Oct 27. Use when asked to publish, release or bump.",
    meta: {
      trail: "s-7f3a2c", scope: "personal", applies: SHOP, job: "release", asks: "publish, release, bump", params: "version",
      check: "npm view acme-cli version", "check-shows": "{version}", version: "1", ...meta,
    },
    steps: [
      { n: 1, cmd: "npm run build", gated: null, bg: false, wait: false, from: ["toolu_01"] },
      { n: 2, cmd: "npm publish --access public", gated: "publish", bg: false, wait: false, from: ["toolu_02"] },
    ],
    check: "npm view acme-cli version",
    checkShows: "{version}",
    checkIsStep: false,
    ifFails: [],
    dontUse: "Other packages, or other repos.",
    params: [{ name: "version", shape: "version", seen: ["1.4.3"] }],
    helpers: [],
    leftOut: { failed: 1, lookOnly: 4, duplicates: 0, plumbing: 0, work: 2 },
    source: { runId: "r-1027-3f9a", commands: 9, failed: 1, at: "2026-10-27T10:44:05.000Z" },
    ...extra,
  };
}

/** A SKILL.md written straight into a folder, as a person (or another tool) would. */
export function writeSkillFile(dir: string, c: CompiledSkill = compiled()): string {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "SKILL.md");
  writeFileSync(file, renderSkillMd(c));
  return file;
}
