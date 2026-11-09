/**
 * Builders for the recall tests: two synthetic skills shaped like compile's
 * output (a ship of acme/webshop to beta then prod, a release of acme-cli to
 * npm), a candidate made the way recall reads one (rendered, then parsed),
 * and a skill state. Made-up repos and values only. Not a test file itself.
 */
import type { CompiledSkill, SkillMeta, SkillState } from "../src/skills/types.js";
import type { Candidate } from "../src/skills/recall.js";
import { parseSkillMd, renderSkillMd } from "../src/skills/skillmd.js";

export const WEBSHOP = "github.com/acme/webshop";
export const CLI = "github.com/acme/cli";

const base = (name: string, meta: SkillMeta, extra: Partial<CompiledSkill>): CompiledSkill => ({
  name, title: name, description: `${name}, from the steps that worked on Oct 14.`, meta,
  steps: [], check: meta.check ?? "", checkShows: meta["check-shows"] ?? null, checkIsStep: false, ifFails: [], dontUse: "Jobs other than this one.",
  params: [], helpers: [], leftOut: { failed: 0, lookOnly: 0, duplicates: 0, plumbing: 0, work: 0 },
  source: { runId: "r-1014-3f9a", commands: 17, failed: 3, at: "2026-10-14T10:44:05.000Z" }, ...extra,
});

export function shipSkill(meta: Partial<SkillMeta> = {}, extra: Partial<CompiledSkill> = {}): CompiledSkill {
  const m: SkillMeta = {
    trail: "s-4c91e0", scope: "personal", applies: WEBSHOP, job: "ship",
    asks: "push to beta, ff to prod, fast-forward prod, promote to prod, deploy to prod, update prod, ship it",
    "status-asks": "is it live, is prod updated, did it deploy", params: "sha=$(git rev-parse HEAD)", needs: "git, gh",
    ready: "git status --porcelain ; git rev-parse --abbrev-ref HEAD = beta", "check-first": "gh auth status",
    "confirm-before": "git push git@github.com:acme/webshop.git {sha}:refs/heads/prod",
    check: "gh api repos/acme/webshop/commits/{sha}/statuses --jq '.[0].state'", "check-shows": "success", version: "1", ...meta,
  };
  return base("ship-beta-then-prod", m, {
    steps: [
      { n: 1, cmd: "git fetch origin", gated: null, bg: false, wait: false },
      { n: 2, cmd: "git push git@github.com:acme/webshop.git {sha}:refs/heads/beta", gated: null, bg: false, wait: false },
      { n: 3, cmd: "s=$SECONDS; until [ \"$(gh api repos/acme/webshop/commits/{sha}/statuses --jq '.[0].state')\" = \"success\" ]; do [ $((SECONDS-s)) -ge 300 ] && echo \"not ready after 5 min\" && break; sleep 10; done", gated: null, bg: false, wait: true },
      { n: 4, cmd: "git merge-base --is-ancestor origin/prod {sha}", gated: null, bg: false, wait: false },
      { n: 5, cmd: "git push git@github.com:acme/webshop.git {sha}:refs/heads/prod", gated: "push-prod", bg: false, wait: false },
    ],
    ifFails: ["`git push` said \"fatal: Authentication failed for 'https://github.com/acme/webshop.git/'\": what worked was step 2."],
    dontUse: "Pushes to other branches, or other repos.",
    params: [{ name: "sha", shape: "sha", default: "$(git rev-parse HEAD)", seen: ["4e1c9a2"] }],
    ...extra,
  });
}

export function releaseSkill(meta: Partial<SkillMeta> = {}, extra: Partial<CompiledSkill> = {}): CompiledSkill {
  const m: SkillMeta = {
    trail: "s-7f3a2c", scope: "personal", applies: CLI, job: "release",
    asks: "publish, release, bump, redo the publish, ship to npm", "status-asks": "is it published, did it publish",
    params: "version", needs: "git, npm, node", ready: "git status --porcelain ; git rev-parse --abbrev-ref HEAD = main", "check-first": "npm whoami",
    "confirm-before": "npm publish acme-core-{version}.tgz --access public ; npm publish acme-cli-{version}.tgz --access public",
    check: "npm view acme-cli version", "check-shows": "{version}", version: "1", ...meta,
  };
  return base("release-npm", m, {
    steps: [
      { n: 1, cmd: "git pull --ff-only origin main", gated: null, bg: false, wait: false },
      { n: 2, cmd: "npm run build", gated: null, bg: false, wait: false },
      { n: 3, cmd: "npm pack", gated: null, bg: false, wait: false },
      { n: 4, cmd: "node scripts/pack-cli.mjs && npm pack ./build/cli", gated: null, bg: false, wait: false },
      { n: 5, cmd: "npm publish acme-core-{version}.tgz --access public", gated: "publish", bg: false, wait: false },
      { n: 6, cmd: "npm publish acme-cli-{version}.tgz --access public", gated: "publish", bg: false, wait: false },
    ],
    ifFails: [
      "`npm publish` said \"npm error code EOTP\": what worked was step 5.",
      "`npm whoami` said you're not signed in: sign in first (the person may need to do this part).",
    ],
    dontUse: "Pre-releases, or packages other than the ones above.",
    params: [{ name: "version", shape: "version", seen: ["1.4.1"] }],
    ...extra,
  });
}

export function state(name: string, extra: Partial<SkillState> = {}): SkillState {
  return {
    name, scope: "personal", status: "active", from: "repeated", runId: "r-1014-3f9a", addedAt: "2026-10-14T11:02:13.000Z",
    lastWorked: "2026-10-14", lastUsedAt: null, lastUsedRepo: null, uses: 1, checkedUses: 1, hash: "sha256:x",
    source: { commands: 17, failed: 3, at: "2026-10-14T10:44:05.000Z" }, lastFails: [], promoteOffers: {}, ...extra,
  };
}

/** A candidate as recall reads one: the SKILL.md rendered by compile, parsed back. */
export function cand(c: CompiledSkill, st: Partial<SkillState> | null = {}): Candidate {
  const skill = parseSkillMd(renderSkillMd(c), c.name);
  if (!skill) throw new Error(`fixture ${c.name} did not parse`);
  return {
    ref: { id: c.meta.trail, name: c.name, scope: c.meta.scope, applies: c.meta.applies ?? null, dir: `/home/dev/.trail/skills/${c.name}`, file: `/home/dev/.trail/skills/${c.name}/SKILL.md` },
    skill,
    state: st === null ? null : state(c.name, st),
  };
}
