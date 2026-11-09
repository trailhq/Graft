/**
 * fix-lab5: a wall whose error lands on piped output that exits 0 (`go test ./... 2>&1 | tail -20`, `timeout 60 npm
 * test | tail`) is a wall hit and a failure for repair detection, so a later fix is a repair and moment 3 can offer
 * it. The 1b lab found all 9 real Docker hits piped like this. 1b's precision safeguards stay: planted echo or cat
 * text and a log file being read are no hit, and a retry that hits the wall again is no fix. Made-up repo and output.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { detectRepairs } from "../src/trace/repairs.js";
import { ask, bash, session } from "./trace-run-fixtures.js";
import { said } from "./trace-fixtures.js";
import { SHOP, append, bash as boxBash, box, say, stop, where } from "./skills-consent-fixtures.js";
import { noteWalls } from "../src/trace/wall-state.js";
import { rmSync } from "node:fs";

const OPTS = { home: "/home/dev", root: "/home/dev/shop" };
/** What `| head` or `| tail` left of a testcontainers start: the wall's words, no FAIL line, no exit code. */
const PANIC = "2026/10/24 10:00:00 github.com/testcontainers/testcontainers-go: rootless Docker not found\n  setup: starting the database container";
const OK = "ok  \tacme/shop/internal/api\t3.2s";
const SOCK = "DOCKER_HOST=unix:///home/dev/.colima/default/docker.sock";

function repairsOf(entries: object[]) {
  const s = session("exit0");
  s.fold(entries);
  const run = s.st.runs[s.st.runs.length - 1]!;
  return { run, repairs: detectRepairs(run, OPTS) };
}

test("the lab's piped Docker wall: an exit-0 hit, then Colima and its socket, is a repair", () => {
  const { run, repairs } = repairsOf([
    ask("run the integration tests", 0),
    ...bash("go test ./internal/api/... 2>&1 | tail -20", PANIC, { sec: 1, cwd: "/home/dev/shop" }),
    ...bash("colima start", "colima is running", { sec: 20, cwd: "/home/dev/shop" }),
    ...bash(`${SOCK} go test ./internal/api/... 2>&1 | tail -20`, OK, { sec: 40, cwd: "/home/dev/shop" }),
  ]);
  assert.equal(run.calls[0]!.wall, "docker-rootless", "the hit counts, exit 0 or not");
  assert.equal(run.calls[0]!.failed, false, "nothing in the text says it failed: only the wall does");
  assert.deepEqual(repairs.map((r) => [r.cls, r.program, r.delta.map((d) => `${d.kind}:${d.name}`)]), [["docker-rootless", "go test", ["enable-step:colima", "env:DOCKER_HOST"]]]);
});

test("precision stays: planted text, a log being read, a retry that hits the wall again, an unpiped exit 0", () => {
  const planted = repairsOf([
    ask("run the integration tests", 0),
    ...bash('echo "panic: rootless Docker not found" | tail -1', "panic: rootless Docker not found", { sec: 1, cwd: "/home/dev/shop" }),
    ...bash(`${SOCK} echo "panic: rootless Docker not found" | tail -1`, OK, { sec: 5, cwd: "/home/dev/shop" }),
  ]);
  assert.deepEqual(planted.repairs, []);
  const log = repairsOf([
    ask("why did ci fail", 0),
    ...bash("cat /tmp/x/tasks/b1.output | tail -40", PANIC, { sec: 1, cwd: "/home/dev/shop" }),
    ...bash(`${SOCK} cat /tmp/x/tasks/b1.output | tail -40`, OK, { sec: 5, cwd: "/home/dev/shop" }),
  ]);
  assert.equal(log.run.calls[0]!.wall, undefined, "reading a log is not a hit");
  assert.deepEqual(log.repairs, []);
  const again = repairsOf([
    ask("run the integration tests", 0),
    ...bash("go test ./internal/api/... 2>&1 | tail -20", PANIC, { sec: 1, cwd: "/home/dev/shop" }),
    ...bash(`${SOCK} go test ./internal/api/... 2>&1 | tail -20`, PANIC, { sec: 40, cwd: "/home/dev/shop" }),
  ]);
  assert.deepEqual(again.repairs, [], "the retry hit the wall too: no fix");
});

test("moment 3 offers it: an earlier fixed epoch, then today's piped exit-0 hit and the same fix", () => {
  const b = box();
  try {
    noteWalls({ fixed: [{ cls: "docker-rootless", d: "2026-10-24", sh: "aaaaaaaaaaaa", epoch: 0, repo: SHOP, program: "go", delta: [{ kind: "env", name: "DOCKER_HOST" }] }] }, b.env);
    say(b, 0, "run the integration tests");
    boxBash(b, 5, "go test ./... 2>&1 | tail -20", PANIC, false);
    boxBash(b, 20, `${SOCK} go test ./... 2>&1 | tail -20`, "ok  \tacme/shop\t0.4s", false);
    append(b, [said("The integration tests pass.", where(b, 30))]);
    const s = stop(b, 50);
    assert.ok(s.offer, s.why);
    assert.equal(s.offer!.moment, "repaired");
    assert.equal(s.offer!.key, `${SHOP}|wall:docker-rootless|go`);
  } finally {
    rmSync(b.root, { recursive: true, force: true });
  }
});
