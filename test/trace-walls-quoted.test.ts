/**
 * D147: every wall ignores its error text where it sits inside quoted or
 * JSON-escaped output, such as a printed record of another session (the
 * labels' w012: a driver command printing another session's Docker error)
 * or a JSON string holding the error. The same error as a real line, even an
 * indented one from a test runner, still fires. Synthetic look-alikes only.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { matchWall } from "../src/trace/walls.js";
import type { WallClass } from "../src/trace/types.js";

const S = "/tmp/claude-501/-Users-dev/0f3c/scratchpad";

/** [class, why, command, result, failed]: a wall's own error, printed from somewhere else. */
const QUOTED: Array<[WallClass, string, string, string, boolean]> = [
  ["docker-rootless", "a driver printing another session's record", `S=${S}; bash $S/run.sh box w2 - "run the integration tests"; python3 -I $S/tools.py $S/box`,
    "$ [Bash] docker info >/dev/null 2>&1 || echo no\n   -> no\n\n$ [Bash] which docker; docker --version 2>&1\n   -> Exit code 1\n      /usr/local/bin/docker\n      Cannot connect to the Docker daemon at unix:///tmp/x/docker.sock\n\n$ [Bash] colima start\n   -> INFO starting colima", false],
  ["docker-rootless", "the error on a record's arrow line", "node scripts/show-run.mjs w2", "-> Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?", true],
  ["docker-rootless", "a JSON string holding the error", "node scripts/dump-session.mjs w2", '{"type":"tool_result","content":"Exit code 1\\nCannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?"}', true],
  ["docker-rootless", "a pretty-printed JSON value", "python3 scripts/report.py --json", '{\n  "line": "panic: rootless Docker not found",\n  "cls": "docker-rootless"\n}', true],
  ["docker-rootless", "a quoted string in a log line", "node scripts/report.mjs", "label row 12: 'rootless Docker not found' came from a printed log", true],
  ["enospc", "a JSON string holding the disk error", "node scripts/dump-session.mjs w2", '{"error":"cp: /tmp/x/a: No space left on device"}', true],
  ["enospc", "a record's arrow line with the disk error", "python3 -I tools.py box", "$ [Bash] cp big.tar /tmp/x/\n   -> cp: /tmp/x/big.tar: No space left on device", true],
];

test("D147 every wall: error text inside quoted or JSON-escaped output is no hit", () => {
  for (const [, why, cmd, out, failed] of QUOTED) assert.equal(matchWall(out, cmd, failed), null, why);
});

test("D147 every wall: the same errors as real lines still fire (indented test output included)", () => {
  const real: Array<[WallClass, string, string, boolean]> = [
    ["docker-rootless", "go test ./internal/store/... 2>&1 | tail -20", "--- FAIL: TestStore\n    store_test.go:31: Failed to get provider: rootless Docker not found\nFAIL", false],
    ["docker-rootless", "go test ./... 2>&1 | tail -5", "panic: rootless Docker not found [recovered, repanicked]\nFAIL\tacme/shop/internal/db\t0.2s", false],
    ["docker-rootless", "docker compose up -d db 2>&1 | tail -3", "Cannot connect to the Docker daemon at unix:///Users/dev/.colima/default/docker.sock. Is the docker daemon running?", false],
    ["docker-rootless", "npm run test:integration", 'Error: Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running? (see "docker info")', true],
    ["enospc", "npm ci", "npm error code ENOSPC\nnpm error syscall write", true],
    ["enospc", "go build ./...", "compile: writing output: write $WORK/b001/_pkg_.a: no space left on device", true],
    ["enospc", "node build.mjs", "ENOSPC: no space left on device, open '/tmp/x/out.output'", true],
    ["enospc", "cp a.tar /tmp/full/", "cp: \"/tmp/full/a.tar\": No space left on device", true],
    ["timeout-missing", "timeout 60 npm test 2>&1 | tail -5", "(eval):1: command not found: timeout", false],
    ["npm-e401-eotp", "npm publish", "npm error code E401\nnpm error 401 Unauthorized", true],
  ];
  for (const [cls, cmd, out, failed] of real) assert.equal(matchWall(out, cmd, failed), cls, `${cls}: ${cmd}`);
});

test("D147: a quoted copy next to a real line still fires on the real line", () => {
  const out = '{"line":"Cannot connect to the Docker daemon at unix:///x.sock"}\nCannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?';
  assert.equal(matchWall(out, "docker compose up -d db", true), "docker-rootless");
});
