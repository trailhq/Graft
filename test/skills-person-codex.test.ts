/**
 * The person check on Codex (phase 2 review): `trail skills restore <name> --version <n>`, `keep`, `skills on` and
 * `offers on` are the person's (P28, 1a). Codex runs the agent's commands as children of the `codex` process, and
 * its exec tool can give a command a terminal (tty), so a TTY alone doesn't tell the person from Codex's agent: a
 * `codex` process among the ancestors is an agent, as the claude CLI is. Synthetic process tables only.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { personAtTerminal, type PsRow } from "../src/skills/store.js";
import { restoreVersionCommand, type CliCtx } from "../src/skills/cli-skills-2.js";

const row = (pid: number, ppid: number, comm: string, args = comm): PsRow => ({ pid, ppid, comm, args });
const SELF = 7000;
/** This process under a shell under `parents` (nearest first), then launchd. */
const tree = (...parents: Array<[string, string?]>): PsRow[] => {
  const rows = [row(SELF, SELF - 10, "/usr/local/bin/node", "node /usr/local/bin/trail skills restore ship-shop --version 1"), row(SELF - 10, SELF - 20, "/bin/zsh", "/bin/zsh -lc trail skills restore ship-shop --version 1")];
  let pid = SELF - 20;
  for (const [comm, args] of parents) {
    rows.push(row(pid, pid - 10, comm, args ?? comm));
    pid -= 10;
  }
  rows.push(row(pid, 1, "/sbin/launchd"), row(1, 0, "/sbin/launchd"));
  return rows;
};
const check = (rows: PsRow[]) => personAtTerminal({}, { stdinTTY: true, stdoutTTY: true, pid: SELF, ps: () => rows });

const CODEX: Array<Array<[string, string?]>> = [
  [["/opt/homebrew/bin/codex", "codex"]],
  [["/home/dev/.npm-global/lib/node_modules/@openai/codex/vendor/aarch64-apple-darwin/codex/codex", "/home/dev/.npm-global/lib/node_modules/@openai/codex/vendor/aarch64-apple-darwin/codex/codex --yolo"],
    ["/usr/local/bin/node", "node /home/dev/.npm-global/lib/node_modules/@openai/codex/bin/codex.js"]],
  [["/usr/local/bin/node", "node /usr/local/lib/node_modules/@openai/codex/bin/codex.js exec ship it"]],
  [["/home/dev/.local/lib/codex/codex-x86_64-unknown-linux-musl", "codex-x86_64-unknown-linux-musl"]],
  [["/Applications/Codex.app/Contents/Resources/codex", "/Applications/Codex.app/Contents/Resources/codex app-server"], ["/Applications/Codex.app/Contents/MacOS/Codex"]],
  // Codex's macOS sandbox wraps the command; the agent is above it.
  [["/usr/bin/sandbox-exec", "/usr/bin/sandbox-exec -p (version 1) -- /bin/zsh -lc trail skills restore ship-shop --version 1"], ["/opt/homebrew/bin/codex", "codex"]],
];

test("a codex process among the ancestors is an agent, even when Codex gave the command a terminal", () => {
  for (const parents of CODEX) {
    const got = check(tree(...parents, ["/usr/bin/login"]));
    assert.deepEqual(got, { ok: false, tty: true, claudeCodeEnv: false, claudeAncestor: true }, parents.map((p) => p[1] ?? p[0]).join(" < "));
  }
});

test("the person's own terminal still passes: a program merely named like codex, or the Codex desktop app itself", () => {
  assert.equal(check(tree(["/usr/local/bin/codex-review", "codex-review --all"], ["/usr/bin/login"])).ok, true);
  assert.equal(check(tree(["/usr/bin/vim", "vim codex.md"], ["/usr/bin/login"])).ok, true);
  assert.equal(check(tree(["/Applications/Codex.app/Contents/MacOS/Codex"])).ok, true);
});

test("restore by version from Codex's agent with a terminal changes nothing and says it is the person's", () => {
  const errs: string[] = [];
  const x: CliCtx = {
    env: { TRAIL_HOME: "/tmp/x-trail-nonexistent" }, now: () => new Date("2026-11-10T10:00:00Z"),
    person: () => check(tree(["/opt/homebrew/bin/codex", "codex"])), track: () => assert.fail("nothing is sent"),
    out: () => assert.fail("nothing is printed as done"), err: (l) => errs.push(l),
  };
  assert.equal(restoreVersionCommand("ship-shop", "1", x), 1);
  assert.deepEqual(errs, ["Only the person can run this, in their own terminal: trail skills restore ship-shop --version 1"]);
});
