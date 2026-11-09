/**
 * Held items (`~/.trail/held/<name>/`, design 2, 1.4): a save Trail could
 * not trust (no yes, or another host) is held, never recalled, shown once at
 * the next session start, keepable for 24 hours after that showing and then
 * deleted. Keeping one is the person's alone: `personAtTerminal` wants both
 * TTYs, no CLAUDECODE and no claude CLI or pty wrapper among the command's
 * ancestors (a `ps` stub here).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync, symlinkSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  dropHeld, findSkill, keepHeld, listAllPersonal, listHeld, listSkills, markHeldShown, personAtTerminal, saveHeld, savePersonal,
  type PersonCheck, type PsRow,
} from "../src/skills/store.js";
import { getSkillState } from "../src/skills/state.js";
import { readLedger } from "../src/skills/ledger.js";
import { renderSkillMd } from "../src/skills/skillmd.js";
import { housekeeping } from "../src/trace/housekeeping.js";
import { withLock } from "../src/util/private-fs.js";
import { box, compiled, SHOP, STOREFRONT } from "./skills-store-fixtures.js";

const POSIX = process.platform !== "win32";
const NOW = new Date("2026-10-28T09:00:00.000Z");
const HOUR = 3600_000;
const later = (h: number) => new Date(NOW.getTime() + h * HOUR);
const PERSON: PersonCheck = { ok: true, tty: true, claudeCodeEnv: false, claudeAncestor: false };
const hold = (b: ReturnType<typeof box>, name = "deploy-shop", why: "no-yes" | "host" = "no-yes", repoKey = SHOP) =>
  saveHeld(compiled(name, { trail: "s-0000a1", job: "ship" }), why, { host: why === "host" ? "cursor" : "claude", job: "ship", repoKey }, b.env, NOW);

test("saveHeld writes held/<name>/SKILL.md and held.json, privately; recall never sees it", () => {
  const b = box("held");
  const c = compiled("deploy-shop", { trail: "s-0000a1", job: "ship" }, { helpers: [{ file: "poll.sh", from: "/tmp/x/poll.sh", content: "#!/bin/sh\n" }] });
  const item = saveHeld(c, "no-yes", { host: "claude", job: "ship", repoKey: SHOP }, b.env, NOW);
  const dir = join(b.trail, "held", "deploy-shop");
  assert.deepEqual(item, { name: "deploy-shop", why: "no-yes", host: "claude", job: "ship", repoKey: SHOP, at: NOW.toISOString(), shownAt: null, dir, runId: "r-1027-3f9a", session: null });
  assert.equal(readFileSync(join(dir, "SKILL.md"), "utf8"), renderSkillMd(c));
  assert.equal(readFileSync(join(dir, "scripts", "poll.sh"), "utf8"), "#!/bin/sh\n");
  const held = JSON.parse(readFileSync(join(dir, "held.json"), "utf8"));
  assert.equal(held.shownAt, null);
  assert.equal(held.why, "no-yes");
  if (POSIX) {
    assert.equal(statSync(join(b.trail, "held")).mode & 0o777, 0o700);
    assert.equal(statSync(dir).mode & 0o777, 0o700);
    assert.equal(statSync(join(dir, "held.json")).mode & 0o777, 0o600);
    assert.equal(statSync(join(dir, "SKILL.md")).mode & 0o777, 0o600);
  }
  const ctx = { repoKeys: [SHOP], checkout: b.checkout, env: b.env };
  assert.deepEqual(listSkills(ctx), []);
  assert.deepEqual(listAllPersonal(b.env), []);
  assert.equal(findSkill("deploy-shop", ctx), null);
  assert.equal(getSkillState("s-0000a1", b.env), null);
  assert.deepEqual(readLedger("s-0000a1", b.env), []);
});

test("a second hold of the same name replaces the first", () => {
  const b = box("held");
  hold(b);
  saveHeld(compiled("deploy-shop", { trail: "s-0000a2", job: "ship" }), "host", { host: "cursor", job: "ship", repoKey: STOREFRONT }, b.env, later(1));
  const items = listHeld(b.env, later(1));
  assert.equal(items.length, 1);
  assert.equal(items[0]!.why, "host");
  // The run it came from, so a live save for the same run can drop it (D65, g5).
  assert.equal(items[0]!.runId, "r-1027-3f9a");
  assert.equal(items[0]!.repoKey, STOREFRONT);
});

test("held items are shown once and keepable for 24 hours after that showing, then housekeeping deletes them", () => {
  const b = box("held");
  hold(b);
  assert.deepEqual(listHeld(b.env, later(100)).map((h) => h.shownAt), [null]);
  markHeldShown("deploy-shop", b.env, later(2));
  markHeldShown("deploy-shop", b.env, later(3));
  assert.deepEqual(listHeld(b.env, later(10)).map((h) => h.shownAt), [later(2).toISOString()]);
  assert.deepEqual(listHeld(b.env, later(25.9)).length, 1);
  assert.deepEqual(listHeld(b.env, later(26.1)), []);
  assert.equal(keepHeld("deploy-shop", PERSON, b.env, later(26.1)).ok, false);
  housekeeping(later(26.1), b.env);
  assert.equal(existsSync(join(b.trail, "held", "deploy-shop")), false);
});

test("dropHeld removes one held item; unknown names and planted links are left alone", () => {
  const b = box("held");
  hold(b);
  hold(b, "ship-storefront");
  dropHeld("deploy-shop", b.env);
  assert.deepEqual(listHeld(b.env, NOW).map((h) => h.name), ["ship-storefront"]);
  dropHeld("../ship-storefront", b.env);
  dropHeld("nope", b.env);
  assert.deepEqual(listHeld(b.env, NOW).map((h) => h.name), ["ship-storefront"]);
});

test("a hook's bookkeeping on a busy store changes nothing and does not throw", () => {
  const b = box("held");
  hold(b);
  const lock = join(b.trail, "skills", ".store");
  const held = withLock(lock, () => {
    markHeldShown("deploy-shop", b.env, later(1));
    dropHeld("deploy-shop", b.env);
    return true;
  });
  assert.equal(held.ok, true);
  assert.deepEqual(listHeld(b.env, later(1)).map((h) => [h.name, h.shownAt]), [["deploy-shop", null]]);
});

test("listHeld skips what Trail did not write: a link, a folder without held.json, a broken held.json", () => {
  const b = box("held");
  hold(b);
  const elsewhere = join(b.home, "elsewhere");
  mkdirSync(join(elsewhere, "x"), { recursive: true });
  writeFileSync(join(elsewhere, "x", "held.json"), JSON.stringify({ name: "x", why: "no-yes", host: "claude", job: null, repoKey: SHOP, at: NOW.toISOString(), shownAt: null }));
  symlinkSync(join(elsewhere, "x"), join(b.trail, "held", "linked"));
  mkdirSync(join(b.trail, "held", "bare"));
  mkdirSync(join(b.trail, "held", "broken"));
  writeFileSync(join(b.trail, "held", "broken", "held.json"), "{nope");
  assert.deepEqual(listHeld(b.env, NOW).map((h) => h.name), ["deploy-shop"]);
});

test("keepHeld: only the person, only a held item still keepable, only onto a free name", () => {
  const b = box("held");
  hold(b);
  for (const p of [
    { ...PERSON, ok: false, claudeCodeEnv: true },
    { ...PERSON, ok: false, tty: false },
    { ...PERSON, ok: false, claudeAncestor: true },
  ]) assert.deepEqual(keepHeld("deploy-shop", p, b.env, NOW), { ok: false, reason: "not-a-person" });
  assert.deepEqual(keepHeld("nope", PERSON, b.env, NOW), { ok: false, reason: "unknown" });
  assert.deepEqual(keepHeld("../deploy-shop", PERSON, b.env, NOW), { ok: false, reason: "unknown" });
  savePersonal(compiled("deploy-shop", { trail: "s-0000b1" }), { from: "asked", runId: "r-1027-0001", consent: "asked", stepsVerified: 2, env: b.env, now: NOW });
  assert.deepEqual(keepHeld("deploy-shop", PERSON, b.env, NOW), { ok: false, reason: "name-taken" });
  assert.ok(existsSync(join(b.trail, "held", "deploy-shop", "SKILL.md")));
});

test("keepHeld moves the held item into the store as a candidate the person asked for", () => {
  const b = box("held");
  saveHeld(compiled("deploy-shop", { trail: "s-0000a1", job: "ship" }, { helpers: [{ file: "poll.sh", from: "/tmp/x/poll.sh", content: "#!/bin/sh\n" }] }),
    "host", { host: "cursor", job: "ship", repoKey: SHOP }, b.env, NOW);
  markHeldShown("deploy-shop", b.env, later(1));
  const kept = keepHeld("deploy-shop", PERSON, b.env, later(5));
  assert.equal(kept.ok, true);
  const dir = join(b.trail, "skills", "deploy-shop");
  assert.deepEqual(kept.ok && kept.ref, { id: "s-0000a1", name: "deploy-shop", scope: "personal", applies: SHOP, dir, file: join(dir, "SKILL.md") });
  assert.equal(existsSync(join(b.trail, "held", "deploy-shop")), false);
  assert.deepEqual(readdirSync(dir).sort(), ["SKILL.md", "lessons", "scripts"]);
  if (POSIX) assert.equal(statSync(join(dir, "scripts", "poll.sh")).mode & 0o777, 0o700);
  const s = getSkillState("s-0000a1", b.env)!;
  assert.equal(s.status, "candidate");
  assert.equal(s.from, "asked");
  assert.equal(s.runId, "r-1027-3f9a");
  assert.deepEqual(s.source, { commands: 9, failed: 1, at: "2026-10-27T10:44:05.000Z" });
  assert.deepEqual(readLedger("s-0000a1", b.env), [{
    at: later(5).toISOString(), event: "saved", skill: "s-0000a1", v: "1", from: "asked", scope: "personal",
    receipt: { consent: "asked", stepsVerified: 0, stepsTotal: 3 },
  }]);
  assert.deepEqual(listSkills({ repoKeys: [SHOP], checkout: b.checkout, env: b.env }).map((r) => r.name), ["deploy-shop"]);
});

// The person check.

const row = (pid: number, ppid: number, comm: string, args = comm): PsRow => ({ pid, ppid, comm, args });
/** A process tree: this process (9000) under a shell under `parents` (nearest first), then launchd (1). */
const SELF = 9000;
const tree = (...parents: Array<[string, string?]>): PsRow[] => {
  const rows = [row(SELF, SELF - 10, "/usr/local/bin/node", "node /usr/local/bin/trail skills keep deploy-shop"), row(SELF - 10, SELF - 20, "-zsh")];
  let pid = SELF - 20;
  for (const [comm, args] of parents) {
    rows.push(row(pid, pid - 10, comm, args ?? comm));
    pid -= 10;
  }
  rows.push(row(pid, 1, "/sbin/launchd"), row(1, 0, "/sbin/launchd"));
  return rows;
};
const check = (rows: PsRow[] | null, env: NodeJS.ProcessEnv = {}, tty = true) =>
  personAtTerminal(env, { stdinTTY: tty, stdoutTTY: tty, pid: SELF, ps: () => rows });

test("personAtTerminal: the person's own terminal passes, the desktop app's panel included", () => {
  assert.deepEqual(check(tree(["/System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal"])), PERSON);
  assert.deepEqual(check(tree(["/Applications/Claude.app/Contents/MacOS/Claude"])), PERSON);
  assert.equal(check(tree(["/usr/bin/tmux", "tmux new -s work"])).ok, true);
});

test("personAtTerminal: CLAUDECODE set or a missing TTY is not the person", () => {
  assert.deepEqual(check(tree(["/usr/bin/login"]), { CLAUDECODE: "1" }), { ok: false, tty: true, claudeCodeEnv: true, claudeAncestor: false });
  assert.deepEqual(check(tree(["/usr/bin/login"]), {}, false), { ok: false, tty: false, claudeCodeEnv: false, claudeAncestor: false });
  assert.equal(personAtTerminal({}, { stdinTTY: true, stdoutTTY: false, pid: SELF, ps: () => tree() }).ok, false);
});

test("personAtTerminal: the claude CLI or a pty wrapper among the ancestors is not the person", () => {
  const agents: Array<[string, string?]> = [
    ["/Users/dev/.local/bin/claude", "claude"],
    ["claude"],
    ["/opt/homebrew/bin/node", "node /opt/homebrew/lib/node_modules/@anthropic-ai/claude-code/cli.js"],
    ["/usr/local/bin/node", "claude --resume"],
    ["/usr/bin/script", "script -q /dev/null trail skills keep deploy-shop"],
    ["/usr/bin/expect", "expect -f keep.exp"],
    ["/opt/homebrew/bin/unbuffer", "unbuffer trail skills keep deploy-shop"],
    ["/usr/bin/python3", "python3 -c import pty; pty.spawn(['trail','skills','keep','x'])"],
    // macOS framework Pythons (Homebrew, Xcode's) run as `Python`, capital P, by name and by argv[0].
    ["/opt/homebrew/Cellar/python@3.14/3.14.2_1/Frameworks/Python.framework/Versions/3.14/Resources/Python.app/Contents/MacOS/Python",
      "/opt/homebrew/Cellar/python@3.14/3.14.2_1/Frameworks/Python.framework/Versions/3.14/Resources/Python.app/Contents/MacOS/Python -c import pty; pty.spawn(['trail'])"],
    // The CLI the desktop app runs, from a path with spaces.
    ["/Users/dev/Library/Application Support/Claude/claude-code/2.1.293/0a1b2c3d4e5f/claude.app/Contents/MacOS/claude",
      "/Users/dev/Library/Application Support/Claude/claude-code/2.1.293/0a1b2c3d4e5f/claude.app/Contents/MacOS/claude --output-format stream-json"],
  ];
  for (const a of agents) {
    const got = check(tree(["/usr/bin/login"], a, ["/bin/zsh"]));
    assert.deepEqual(got, { ok: false, tty: true, claudeCodeEnv: false, claudeAncestor: true }, a.join(" | "));
  }
  // A python that only happens to be an ancestor is fine; so is a program named like claude but not it.
  assert.equal(check(tree(["/usr/bin/python3", "python3 server.py"])).ok, true);
  assert.equal(check(tree(["/usr/local/bin/claude-squad", "claude-squad"])).ok, true);
});

test("personAtTerminal looks 12 levels up, and fails closed when the process table can't be read", () => {
  const deep: Array<[string, string?]> = Array.from({ length: 10 }, () => ["/bin/bash"] as [string]);
  assert.equal(check(tree(...deep, ["claude"])).claudeAncestor, true);
  const deeper: Array<[string, string?]> = Array.from({ length: 13 }, () => ["/bin/bash"] as [string]);
  assert.equal(check(tree(...deeper, ["claude"])).claudeAncestor, false);
  assert.deepEqual(check(null), { ok: false, tty: true, claudeCodeEnv: false, claudeAncestor: true });
  assert.equal(check([row(9, 1, "x")]).ok, false);
});

test("keepHeld through the person check: CLAUDECODE, no TTY and a claude ancestor are each refused", () => {
  const b = box("held");
  hold(b);
  const refused = [
    check(tree(["/usr/bin/login"]), { CLAUDECODE: "1" }),
    check(tree(["/usr/bin/login"]), {}, false),
    check(tree(["claude"])),
  ];
  for (const p of refused) assert.deepEqual(keepHeld("deploy-shop", p, b.env, NOW), { ok: false, reason: "not-a-person" });
  assert.equal(keepHeld("deploy-shop", check(tree(["/usr/bin/login"])), b.env, NOW).ok, true);
});

test("personAtTerminal reads the real process table here without throwing; under Claude Code it finds the CLI", () => {
  const p = personAtTerminal({});
  assert.equal(typeof p.ok, "boolean");
  assert.equal(typeof p.claudeAncestor, "boolean");
  // Run from an agent's shell (this suite under Claude Code), the CLI is among the ancestors even with CLAUDECODE cleared.
  if (process.env.CLAUDECODE) assert.deepEqual(personAtTerminal({}).claudeAncestor, true);
});
