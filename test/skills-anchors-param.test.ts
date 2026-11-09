/**
 * fix-lab5, J14b: a ship skill whose push is a parameter (`git push origin {arg1}`, `arg1=beta:prod`) gets its
 * branch anchors from the parameter's recorded value, so "may be out of date" can show when prod is gone. A value
 * the skill can't know (a `$(…)` default, several values seen and none kept) is no anchor. Synthetic checkout.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { tmpRepo } from "./helpers.js";
import { anchorsOf, goneAnchors, outOfDateLine, type Anchor } from "../src/skills/anchors.js";
import type { ParamDef, ParsedSkill } from "../src/skills/types.js";

const kinds = (a: Anchor[]) => a.map((x) => `${x.kind}:${x.name}${x.remote ? `@${x.remote}` : ""}#${x.step}`);

function ship(params: ParamDef[], push = "git push origin {arg1}"): ParsedSkill {
  return {
    name: "ship-prod", description: "", meta: { trail: "s-0a1b2c", scope: "personal", asks: "push to prod", version: "1" },
    steps: [
      { n: 1, cmd: "git merge-base --is-ancestor origin/prod origin/beta", gated: null, bg: false, wait: false },
      { n: 2, cmd: push, gated: "push", bg: false, wait: false },
    ],
    check: push, checkShows: null, ifFails: [], dontUse: "", params, hash: "sha256:x",
  } as ParsedSkill;
}

test("the push's parameter gives its branch anchors from the value it recorded", () => {
  assert.deepEqual(kinds(anchorsOf(ship([{ name: "arg1", shape: "varied", default: "beta:prod", seen: [] }])).filter((a) => a.kind === "branch")),
    ["branch:prod@origin#2", "branch:beta@origin#2"]);
  assert.deepEqual(kinds(anchorsOf(ship([{ name: "branch", shape: "branch", seen: ["prod"] }], "git push origin {branch}")).filter((a) => a.kind === "branch")),
    ["branch:prod@origin#2"], "a value seen once, with no default");
});

test("a value the skill can't know is no anchor: a command default, several values seen, a sha, a param in the remote", () => {
  for (const [params, push] of [
    [[{ name: "arg1", shape: "varied", default: "$(git rev-parse --abbrev-ref HEAD):prod", seen: [] }], "git push origin {arg1}"],
    [[{ name: "branch", shape: "branch", seen: ["beta", "prod"] }], "git push origin {branch}"],
    [[{ name: "sha", shape: "sha", default: "$(git rev-parse HEAD)", seen: [] }], "git push origin {sha}:refs/heads/prod"],
    [[{ name: "arg1", shape: "varied", default: "upstream", seen: [] }], "git push {arg1} main"],
    [[{ name: "arg1", shape: "varied", default: "beta prod", seen: [] }], "git push origin {arg1}"],
  ] as Array<[ParamDef[], string]>) {
    const names = kinds(anchorsOf(ship(params, push)).filter((a) => a.kind === "branch"));
    assert.ok(!names.some((n) => /beta|upstream|main/.test(n)) && names.every((n) => n.startsWith("branch:prod@origin")), `${push} ${JSON.stringify(params)}: ${names}`);
  }
});

test("J14b: with prod gone from origin, the ship skill reads may be out of date", () => {
  const dir = tmpRepo("anchors-param");
  try {
    const checkout = join(dir, "src", "webshop");
    const bin = join(dir, "bin");
    mkdirSync(join(checkout, ".git", "refs", "remotes", "origin"), { recursive: true });
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "git"), "#!/bin/sh\n");
    chmodSync(join(bin, "git"), 0o755);
    writeFileSync(join(checkout, ".git", "config"), '[remote "origin"]\n\turl = https://github.com/acme/webshop.git\n');
    for (const b of ["beta", "prod"]) writeFileSync(join(checkout, ".git", "refs", "remotes", "origin", b), "4e1c9a2f00000000000000000000000000000000\n");
    const env = { HOME: join(dir, "home"), PATH: bin, TRAIL_HOME: join(dir, "trail") };
    const s = ship([{ name: "arg1", shape: "varied", default: "beta:prod", seen: [] }]);
    assert.deepEqual(goneAnchors(s, checkout, env), []);
    rmSync(join(checkout, ".git", "refs", "remotes", "origin", "prod"));
    const gone = goneAnchors(s, checkout, env);
    assert.deepEqual(kinds(gone), ["branch:prod@origin#2"]);
    assert.match(outOfDateLine("ship-prod", gone), /^ship-prod may be out of date: it pushes to prod, and origin has no prod branch now\./);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
