/**
 * The fix lists (D104): one copy, in risk-delta.ts, read by the repair
 * detector and by moment 4's fix command. Synthetic commands only.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { riskyCommand, riskyDelta } from "../src/skills/risk-delta.js";

test("the lists live in risk-delta.ts only: repairs.ts imports them, never a copy", () => {
  const repairs = readFileSync(new URL("../src/trace/repairs.ts", import.meta.url), "utf8");
  for (const name of ["RISKY_FLAG", "RISKY_ENV", "RISKY_STEP", "OWN_FILES", "UNSEEN"]) {
    assert.doesNotMatch(repairs, new RegExp(`const ${name}\\s*=`), name);
  }
  assert.match(repairs, /from '\.\.\/skills\/risk-delta\.js'/);
  assert.doesNotMatch(repairs, /function riskyDelta/);
});

test("riskyDelta keeps b2's rules", () => {
  assert.equal(riskyDelta({ kind: "flag", name: "--no-verify", text: "--no-verify" }), true);
  assert.equal(riskyDelta({ kind: "flag", name: "-fq", text: "-fq" }), true);
  assert.equal(riskyDelta({ kind: "env", name: "HUSKY", text: "HUSKY=0" }), true);
  assert.equal(riskyDelta({ kind: "env", name: "DOCKER_HOST", text: "DOCKER_HOST=unix://$HOME/.colima/default/docker.sock" }), false);
  assert.equal(riskyDelta({ kind: "enable-step", name: "gh", text: "gh auth setup-git" }), true);
  assert.equal(riskyDelta({ kind: "enable-step", name: "colima", text: "colima start" }), false);
});

test("riskyCommand: a fix command with a bypass flag, a risky env, a login, Trail's files or a substitution is not used", () => {
  for (const bad of [
    "git push --no-verify origin v1.4.3",
    "git push -f origin v1.4.3",
    "HUSKY=0 git push origin v1.4.3",
    "NPM_TOKEN=$X npm publish",
    "npm login",
    "gh auth setup-git",
    "git config --global core.hooksPath /dev/null",
    "cp notes.md ~/.trail/learnings/x.md",
    "git push origin $(cat /tmp/tag)",
    "bash /tmp/fix.sh",
    "git push origin v1.4.3‮",
    "",
  ]) assert.equal(riskyCommand(bad), true, bad);
  for (const ok of ["git push origin v1.4.3", "npm run build", "DOCKER_HOST=unix://$HOME/.colima/default/docker.sock go test ./...", "make release VERSION=1.4.3"]) {
    assert.equal(riskyCommand(ok), false, ok);
  }
});

test("riskyCommand is linear on a long command and refuses one past 4 KB unread", () => {
  const t = Date.now();
  assert.equal(riskyCommand(`git push ${"x ".repeat(1_000_000)}`), true);
  assert.ok(Date.now() - t < 500);
});

test("a git config set for one command is risky, as a fix or as a repair's enabling step", () => {
  for (const cmd of ["git -c core.hooksPath=/dev/null push origin --tags", "git -C . -c commit.gpgsign=false commit -m x", "git --config-env=core.sshCommand=X fetch"]) {
    assert.equal(riskyCommand(cmd), true, cmd);
    assert.equal(riskyDelta({ kind: "enable-step", name: "", text: cmd }), true, cmd);
  }
  assert.equal(riskyCommand("git -C packages/cli push origin --tags"), false, "-C is a directory");
});
