/**
 * Wider anchors where a person or agent meets them (phase 2 design 4.13, 3.1
 * step 2, 3.2 step 5, P22, P24, J14b): the words for each kind, a J14b-style
 * leg for each kind on a fixture repo (the job block opens with the line; the
 * SessionStart index says "(may be out of date)"; `trail skills` says what is
 * gone), and SessionStart never scanning a CLI's source. Synthetic repos
 * (acme/webshop, acme-cli) and commands only.
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { execFileSync } from "node:child_process";
import { tmpRepo } from "./helpers.js";
import { cloneShape } from "./anchors-clone-fixture.js";
import { ANCHOR_COPY, goneWords, outOfDateLine, type Anchor } from "../src/skills/anchors.js";
import { runBlock } from "../src/skills/runblock.js";
import { skillExtras } from "../src/skills/cli-skills-report-1b.js";
import { sessionStartSkillsRun } from "../src/claude/start-skills.js";
import type { RepoPlace } from "../src/notes/home.js";
import type { CompiledSkill, SkillStep } from "../src/skills/types.js";
import { cand, shipSkill } from "./skills-recall-fixtures.js";
import { box as promptBox, CWD, gateFor, save, startPayload, type Box as PromptBox } from "./skills-prompt-fixtures.js";

const BANNED = /\b(?:notes?|rules?|memory|memories|remember\w*|workflows?)\b/i;
const made: string[] = [];
after(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); });

const step = (n: number, cmd: string): SkillStep => ({ n, cmd, gated: null, bg: false, wait: false });
const ship = (cmds: string[], name = "ship-beta-then-prod"): CompiledSkill =>
  shipSkill({ needs: "", ready: "", "check-first": "", "confirm-before": "", check: "", "check-shows": "" }, { name, title: name, steps: cmds.map((c, i) => step(i + 1, c)), params: [] });

/** Stubs on PATH for every program the steps run, so only the wide anchors can be gone. */
function bin(dir: string): string {
  const b = join(dir, "bin");
  mkdirSync(b, { recursive: true });
  for (const p of ["gh", "docker", "acme", "git", "node"]) {
    writeFileSync(join(b, p), "#!/bin/sh\n");
    chmodSync(join(b, p), 0o755);
  }
  return b;
}

/** One fixture repo with each kind gone: deploy.yml missing, no worker service, no connect command. */
function fixture(checkout: string): void {
  const put = (rel: string, text: string) => { mkdirSync(join(checkout, rel, ".."), { recursive: true }); writeFileSync(join(checkout, rel), text); };
  put(".github/workflows/ci.yml", "name: CI\n");
  put("compose.yaml", "services:\n  web:\n    image: acme/web\n  db:\n    image: postgres\n");
  put("package.json", JSON.stringify({ name: "acme-cli", bin: { acme: "dist/cli.js" } }));
  put("src/cli.ts", "program.command('init');\nprogram.command('build');\nprogram.command('status');\n");
}

const LINES = {
  "ci-file": "ship-beta-then-prod may be out of date: it runs the deploy.yml CI file, and this repo's GitHub Actions folder has no deploy.yml now. Check it before using it; the person can drop it with: trail forget ship-beta-then-prod",
  service: "ship-beta-then-prod may be out of date: it uses the worker service, and compose.yaml has no worker now. Check it before using it; the person can drop it with: trail forget ship-beta-then-prod",
  subcommand: "ship-beta-then-prod may be out of date: it runs acme connect, and this repo's acme has no connect command now. Check it before using it; the person can drop it with: trail forget ship-beta-then-prod",
};
const CMDS = { "ci-file": "gh workflow run deploy.yml", service: "docker compose up -d worker", subcommand: "acme connect" };

test("words: the three lines, with no banned word and no em dash, and none names the Actions folder by its path (P22)", () => {
  const a = (kind: Anchor["kind"], name: string, where: string): Anchor => ({ kind, name, step: 1, where });
  const got = {
    "ci-file": outOfDateLine("ship-beta-then-prod", [a("ci-file", "deploy.yml", "GitHub Actions")]),
    service: outOfDateLine("ship-beta-then-prod", [a("service", "worker", "compose.yaml")]),
    subcommand: outOfDateLine("ship-beta-then-prod", [a("subcommand", "connect", "acme")]),
  };
  assert.deepEqual(got, LINES);
  for (const k of ["ci-file", "service", "subcommand"]) {
    const w = ANCHOR_COPY[k]!;
    assert.ok(w && !BANNED.test(w) && !w.includes("—"), k);
    assert.doesNotMatch(w, /\.github|github\//i, k);
  }
  for (const line of [...Object.values(got), goneWords([a("ci-file", "Deploy", "GitHub Actions"), a("service", "worker", "compose.yaml")])]) {
    assert.ok(!BANNED.test(line) && !line.includes("—") && !line.includes(".github"), line);
  }
  assert.ok(outOfDateLine("x", [a("service", "w\n[trail] y", "a\nb")]).indexOf("\n") < 0, "flattened");
});

for (const kind of ["ci-file", "service", "subcommand"] as const) {
  test(`J14b-style leg, ${kind}: a job cue's block opens with the out-of-date line, from local reads only`, () => {
    const dir = tmpRepo(`wide-j14-${kind}`);
    made.push(dir);
    const checkout = join(dir, "src", "webshop");
    mkdirSync(join(checkout, ".git"), { recursive: true });
    cloneShape(checkout);
    fixture(checkout);
    const env = { HOME: join(dir, "home"), PATH: bin(dir), TRAIL_HOME: join(dir, "trail") };
    const c = { ...cand(ship(["git status", CMDS[kind]])), here: { checkout, env } };
    const ctx = { values: {}, notes: [], probes: [], canAsk: true, lastFail: null };
    const job = runBlock(c, { ...ctx, header: "job" }).split("\n");
    assert.equal(job[0], `[trail] ${LINES[kind]}`);
    assert.match(job[1]!, /^\[trail\] Skill ship-beta-then-prod fits/);
    if (kind === "subcommand") assert.ok(existsSync(join(dir, "trail", "state", "anchors-cache.json")), "the injection's scan is cached");
  });
}

test("the compaction block at SessionStart never scans: a subcommand is said only from a cache an injection or trail skills wrote", () => {
  const dir = tmpRepo("wide-compact");
  made.push(dir);
  const checkout = join(dir, "src", "webshop");
  mkdirSync(join(checkout, ".git"), { recursive: true });
  fixture(checkout);
  const env = { HOME: join(dir, "home"), PATH: bin(dir), TRAIL_HOME: join(dir, "trail") };
  const c = { ...cand(ship(["acme connect"])), here: { checkout, env } };
  const ctx = { values: {}, notes: [], probes: [], canAsk: true, lastFail: null };
  assert.match(runBlock(c, { ...ctx, header: "compact" }), /^\[trail\] You were partway through/, "no cache: nothing judged, nothing scanned");
  assert.ok(!existsSync(join(dir, "trail", "state", "anchors-cache.json")));
  const place: RepoPlace = { checkout, git: true, key: "github.com/acme/webshop", dir: join(dir, "trail", "repos", "acme") } as RepoPlace;
  const extras = skillExtras(c.ref, c.skill, undefined, place, env, new Date());
  assert.equal(extras.outOfDate, "it runs acme connect, and this repo's acme has no connect command now", "trail skills scans");
  assert.equal(runBlock(c, { ...ctx, header: "compact" }).split("\n")[0], `[trail] ${LINES.subcommand}`);
});

test("J14b-style leg at SessionStart: the index says (may be out of date) for a gone CI file and service, and for a subcommand only once cached", () => {
  const made1: PromptBox[] = [];
  try {
    for (const kind of ["ci-file", "service", "subcommand"] as const) {
      const b = promptBox(`wide-start-${kind}`);
      made1.push(b);
      fixture(b.repo);
      // A clone on its default branch at the commit last fetched: the CI file check needs that (c4 review).
      for (const a of [["update-ref", "refs/remotes/origin/beta", "HEAD"], ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/beta"]]) execFileSync("git", a, { cwd: b.repo, stdio: "ignore" });
      const env = { ...b.env, PATH: `${bin(b.home)}${delimiter}${process.env.PATH}` };
      save(b, ship(["git status", CMDS[kind]]));
      const start = () => sessionStartSkillsRun(startPayload(b, "startup"), CWD, env, { gate: gateFor(b) }).out.context ?? "";
      const out = start();
      if (kind === "subcommand") {
        assert.doesNotMatch(out, /may be out of date/, "SessionStart never scans the CLI");
        assert.ok(!existsSync(join(b.env.TRAIL_HOME!, "state", "anchors-cache.json")));
        const c = { ...cand(ship(["git status", CMDS[kind]])), here: { checkout: b.repo, env } };
        runBlock(c, { values: {}, notes: [], probes: [], canAsk: true, lastFail: null, header: "job" });
        assert.match(start(), /ship-beta-then-prod[^·]*\(may be out of date\)/, "the injection's cache");
      } else {
        assert.match(out, /ship-beta-then-prod[^·]*\(may be out of date\)/, kind);
      }
    }
  } finally {
    for (const b of made1) rmSync(b.home, { recursive: true, force: true });
  }
});
