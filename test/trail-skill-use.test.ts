/**
 * A coding agent using one of the repo's skills goes to the workspace as a
 * run of it: the skill's name only, never the task or the prompt, and only
 * for a skill the repo keeps and the workspace already has.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { BRAND_ENV } from "../src/brand.js";
import { recordSkillUse, SAME_RUN_MS, skillOfPrompt, skillOfToolUse } from "../src/claude/skill-use.js";
import { flushActivity, syncRepo } from "../src/cloud/workspace-sync.js";
import { isError, type Cloud } from "../src/cloud/workspace.js";
import { tmpRepo } from "./helpers.js";

process.env.DO_NOT_TRACK = "1";
process.env[BRAND_ENV] = "trail";
process.env.TRAIL_NO_FETCH = "1";
process.env.TRAIL_HOME = mkdtempSync(join(tmpdir(), "skill-use-home-"));

const KEY = "github.com/acme/billing";
const SKILL = "---\nname: cut-a-release\ndescription: Tag, build and publish a release.\n---\n1. Run the tests.\n2. Tag it.\n";

function git(cwd: string, ...args: string[]): void {
  const r = spawnSync("git", ["-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
}

function repo(tag: string): string {
  const d = tmpRepo(`skill-use-${tag}`);
  for (const [p, text] of Object.entries({ "README.md": "billing\n", ".claude/skills/cut-a-release/SKILL.md": SKILL })) {
    mkdirSync(dirname(join(d, p)), { recursive: true });
    writeFileSync(join(d, p), text);
  }
  git(d, "init", "-q", "-b", "main");
  git(d, "config", "user.name", "Priya Raman");
  git(d, "config", "user.email", "priya@acme.test");
  git(d, "add", "-A");
  git(d, "commit", "-qm", "init");
  git(d, "remote", "add", "origin", `https://${KEY}.git`);
  return d;
}

function trail(repos: string[]) {
  const sent: any[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname;
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    sent.push({ path, body });
    const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200 });
    if (path === "/api/cli/learnings") return json({ repo: body.repo.key, learnings: body.learnings.length, added: 0 });
    if (path === "/api/cli/activity") return json({ stored: body.events.length });
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
  const cloud: Cloud = {
    url: "http://trail.test",
    token: "trl_x",
    user: { name: "Priya", email: "priya@acme.test" },
    workspace: { id: "w", name: "Acme", slug: "acme", url: "http://trail.test/w/acme", invite_url: "http://trail.test/join/x" },
    repos,
    linkedAt: Date.now() - 60_000,
  };
  return { cloud, sent, fetchImpl };
}

const outbox = () => {
  const p = join(process.env.TRAIL_HOME!, "outbox.jsonl");
  return existsSync(p) ? readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
};
const clearOutbox = () => rmSync(join(process.env.TRAIL_HOME!, "outbox.jsonl"), { force: true });
const use = (skill: string, session = "s1") => ({ session_id: session, tool_name: "Skill", tool_input: { skill, args: "ship 2.4 to customers at acme" } });

test("the skill a Skill call or a /name prompt uses, and nothing else", () => {
  assert.equal(skillOfToolUse(use("cut-a-release")), "cut-a-release");
  assert.equal(skillOfToolUse({ tool_name: "Skill", tool_input: { command: "/cut-a-release" } }), "cut-a-release");
  assert.equal(skillOfToolUse(use("superpowers:brainstorming")), "", "a plugin's skill is not the repo's");
  assert.equal(skillOfToolUse({ tool_name: "Read", tool_input: { skill: "cut-a-release" } }), "");
  assert.equal(skillOfPrompt("/cut-a-release 2.4"), "cut-a-release");
  assert.equal(skillOfPrompt("  /cut-a-release"), "cut-a-release");
  assert.equal(skillOfPrompt("please /cut-a-release"), "");
  assert.equal(skillOfPrompt("/../etc"), "");
});

test("a repo skill's use is queued by name only, once per run", () => {
  clearOutbox();
  const d = repo("queue");
  const { cloud } = trail([KEY]);
  const now = Date.now();
  assert.equal(recordSkillUse("cut-a-release", use("cut-a-release"), d, { cloud, now }), true);
  // The person typed /cut-a-release, then the agent loaded it: one run.
  assert.equal(recordSkillUse("cut-a-release", use("cut-a-release"), d, { cloud, now: now + 5_000 }), false);
  assert.equal(recordSkillUse("cut-a-release", use("cut-a-release"), d, { cloud, now: now + SAME_RUN_MS + 1 }), true, "a later run counts");
  assert.equal(recordSkillUse("cut-a-release", use("cut-a-release", "s2"), d, { cloud, now: now + 6_000 }), true, "another session counts");

  const queued = outbox();
  assert.equal(queued.length, 3);
  assert.deepEqual(Object.keys(queued[0]).sort(), ["asker", "at", "file_count", "kind", "repo", "session", "shown_authors", "shown_paths", "skill"]);
  assert.equal(queued[0].kind, "skill");
  assert.equal(queued[0].skill, "cut-a-release");
  assert.equal(queued[0].repo, KEY);
  assert.doesNotMatch(JSON.stringify(queued), /acme ship|customers/, "never the task");
});

test("only the repo's own skills, only for a workspace repo", () => {
  clearOutbox();
  const d = repo("only");
  assert.equal(recordSkillUse("deck", use("deck"), d, { cloud: trail([KEY]).cloud }), false, "not a skill the repo keeps");
  assert.equal(recordSkillUse("cut-a-release", use("cut-a-release"), d, { cloud: trail(["github.com/acme/web"]).cloud }), false, "repo not in the workspace");
  assert.equal(recordSkillUse("cut-a-release", use("cut-a-release"), d, { cloud: null }), false, "not connected");
  assert.equal(recordSkillUse("", use(""), d, { cloud: trail([KEY]).cloud }), false);
  assert.equal(outbox().length, 0);
});

test("a run goes up only once the workspace has the skill", async () => {
  clearOutbox();
  const d = repo("flush");
  const t = trail([KEY]);
  assert.equal(recordSkillUse("cut-a-release", use("cut-a-release"), d, { cloud: t.cloud }), true);
  // Nothing synced from this machine yet: the run names a skill the workspace may not have.
  assert.equal(await flushActivity(t.cloud, t.fetchImpl), 0);
  assert.equal(t.sent.filter((s) => s.path === "/api/cli/activity").length, 0);

  const res = await syncRepo(d, t.cloud, { fetch: false, fetchImpl: t.fetchImpl });
  assert.ok(!isError(res), JSON.stringify(res));
  assert.equal(recordSkillUse("cut-a-release", use("cut-a-release", "s3"), d, { cloud: t.cloud }), true);
  assert.equal(await flushActivity(t.cloud, t.fetchImpl), 1);
  const events = t.sent.find((s) => s.path === "/api/cli/activity").body.events;
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, "skill");
  assert.equal(events[0].skill, "cut-a-release");
});
