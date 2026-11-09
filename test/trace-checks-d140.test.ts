/**
 * D140: two more check families. bats is a tests runner (TAP and its pretty summary read for pass and fail), and
 * deploy-status reads are deploy checks: `gcloud run services describe` showing the service Ready, and a
 * `curl -fsS` of a health URL after the run pushed or deployed. Each only reads, so each can be a skill's check
 * line (D116 1). A changing command (`gcloud run deploy`) never is, and the near misses stay out: `bats --version`,
 * `gcloud run services list`, a curl without --fail, a POST, a health read with no push or deploy before it, and
 * `gh run watch` without --exit-status (it exits 0 on a failed run). Made-up services and URLs.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { RunCall } from "../src/trace/types.js";
import { callKind, checkFamilyOf, classifyCheck, factsFromCalls, type RunFacts } from "../src/trace/checks.js";
import { readOnlyCheck } from "../src/skills/runblock.js";

const OK = { failed: false, isError: false };
const BAD = { failed: true, isError: true };
const NONE: RunFacts = { versions: [], shas: [], pushedBranches: [] };
const PUSHED: RunFacts = { versions: [], shas: ["9c8b7a6"], pushedBranches: ["main"] };
const DESCRIBE = "gcloud run services describe shop-api --region us-central1 --format=json";
const HEALTH = "curl -fsS https://shop-api.example.test/healthz";

let n = 0;
const call = (cmd: string, over: Partial<RunCall> = {}): RunCall => {
  n++;
  return { id: `toolu_${n}`, at: "2026-10-27T10:31:52Z", cmd, key: "github.com/acme/shop", cwd: "", bg: false, failed: false, isError: false, kind: "step", src: { use: n * 100, result: n * 100 + 50 }, ...over };
};

test("families from the command alone: bats, gcloud describe, a health curl; near misses stay out", () => {
  const cases: Array<[string, string | null]> = [
    ["bats test/", "tests"], ["bats -r test", "tests"], ["bats test/sql-output.bats", "tests"], ["npx bats test/", "tests"], ["cd cli && bats --tap test/", "tests"],
    ["bats --version", null], ["bats -v", null], ["bats --help", null], ["bats", null],
    [DESCRIBE, "deploy"], ["gcloud run services describe web --format='value(status.conditions[0].status)'", "deploy"],
    ["gcloud run services list", null], ["gcloud run deploy shop-api --source . --region us-central1", null], ["gcloud run services update shop-api --memory 1Gi", null],
    [HEALTH, "deploy"], ["curl -sSf https://shop-api.example.test/health", "deploy"], ["curl --fail -s https://shop-api.example.test/api/status", "deploy"],
    ["curl -s https://shop-api.example.test/healthz", null], ["curl -fsS -X POST https://shop-api.example.test/healthz", null], ["curl -fsS https://shop-api.example.test/api/users", null],
    ["gh run watch 991", null],
    // A local server is not a deploy, and a loop that waits on a health URL is the wait step (D58 d), not a check.
    ["curl -fsS http://localhost:3000/health", null], ["curl -fsS http://127.0.0.1:8080/healthz", null],
    ["while ! curl -fsS https://shop-api.example.test/healthz >/dev/null; do\n  sleep 2\ndone", null],
    ["until curl -fsS https://shop-api.example.test/healthz; do sleep 5; done", null],
  ];
  for (const [cmd, want] of cases) assert.equal(checkFamilyOf(cmd, null), want, cmd);
  for (const cmd of [DESCRIBE, HEALTH]) assert.equal(callKind(cmd, "ship"), "look", `${cmd} only reads`);
});

test("bats: TAP and the pretty summary say pass or fail", () => {
  assert.deepEqual(classifyCheck("bats test/", "1..3\nok 1 prints the header\nok 2 counts rows\nok 3 exits 0", OK, NONE, "tests"), { family: "tests", passed: true, facts: { passedCount: 3 } });
  assert.equal(classifyCheck("bats test/", "1..3\nok 1 prints the header\nnot ok 2 counts rows\n# (in test file test/a.bats, line 9)\nok 3 exits 0", OK, NONE, "tests")?.passed, false);
  assert.equal(classifyCheck("bats test/", " ✓ prints the header\n ✓ counts rows\n\n2 tests, 0 failures", OK, NONE, "tests")?.passed, true);
  assert.equal(classifyCheck("bats test/", " ✓ prints the header\n ✗ counts rows\n\n2 tests, 1 failure", OK, NONE, "tests")?.passed, false);
  assert.equal(classifyCheck("bats test/", "1..2\nok 1 a\nok 2 b", BAD, NONE, "tests")?.passed, false, "a failed call never passes");
});

test("gcloud describe: Ready True passes; False, Unknown or just a URL does not", () => {
  const json = '{"status": {"conditions": [{"lastTransitionTime": "2026-10-27T10:30:00Z", "status": "True", "type": "Ready"}], "url": "https://shop-api-x.a.run.app"}}';
  assert.equal(classifyCheck(DESCRIBE, json, OK, PUSHED, "ship")?.passed, true);
  assert.equal(classifyCheck(DESCRIBE, json.replace('"True"', '"False"'), OK, PUSHED, "ship")?.passed, false);
  assert.equal(classifyCheck(DESCRIBE, json.replace('"True"', '"Unknown"'), OK, PUSHED, "ship")?.passed, false);
  const yaml = "status:\n  conditions:\n  - lastTransitionTime: '2026-10-27T10:30:00Z'\n    status: 'True'\n    type: Ready\n  url: https://shop-api-x.a.run.app";
  assert.equal(classifyCheck("gcloud run services describe shop-api --format=yaml", yaml, OK, PUSHED, "ship")?.passed, true);
  assert.equal(classifyCheck("gcloud run services describe web --format='value(status.conditions[0].status)'", "True\n", OK, PUSHED, "ship")?.passed, true);
  assert.equal(classifyCheck("gcloud run services describe web --format='value(status.url)'", "https://web-x.a.run.app\n", OK, PUSHED, "ship")?.passed, false, "a URL proves nothing");
  assert.equal(classifyCheck("gcloud run services describe web", "✔ Service web in region us-central1\n\nURL:     https://web-x.a.run.app", OK, PUSHED, "ship")?.passed, true);
  assert.equal(classifyCheck("gcloud run services describe web", "✘ Service web in region us-central1", OK, PUSHED, "ship")?.passed, false);
  assert.deepEqual(classifyCheck(DESCRIBE, json.replace('"url"', '"image": "gcr.io/acme/shop-api:9c8b7a6", "url"'), OK, PUSHED, "ship")?.facts, { sha: "9c8b7a6", state: "Ready" });
});

test("a health curl is a check only after the run pushed or deployed, and only when it came back healthy", () => {
  assert.equal(classifyCheck(HEALTH, '{"status":"ok"}', OK, NONE, "ship"), null, "no push or deploy before it");
  assert.deepEqual(classifyCheck(HEALTH, '{"status":"ok"}', OK, PUSHED, "ship"), { family: "deploy", passed: true, facts: { state: "healthy" } });
  assert.equal(classifyCheck(HEALTH, "curl: (22) The requested URL returned error: 503", BAD, PUSHED, "ship")?.passed, false);
  assert.equal(classifyCheck(HEALTH, '{"status":"unhealthy","db":"down"}', OK, PUSHED, "ship")?.passed, false);
  assert.equal(classifyCheck(`${HEALTH} || echo down`, '{"status":"ok"}', OK, PUSHED, "ship")?.passed, false, "behind a fallback (D101)");
  const deployed = factsFromCalls([call("gcloud run deploy shop-api --source . --region us-central1", { tail: "Service [shop-api] revision [shop-api-00007] has been deployed" })], {});
  assert.equal(deployed.deployed, true);
  assert.equal(classifyCheck(HEALTH, "ok", OK, deployed, "ship")?.passed, true);
  assert.ok(!factsFromCalls([call("gcloud run deploy shop-api --source .", { failed: true })], {}).deployed, "a failed deploy deployed nothing");
});

test("D116 1: each read is a check line; the deploy that changes things never is", () => {
  const skill = (check: string, job: "ship" | "tests") => ({ check, steps: [{ n: 1, cmd: check, gated: null, bg: false, wait: false }], meta: { job } }) as never;
  for (const [cmd, job] of [["bats test/", "tests"], [DESCRIBE, "ship"], [HEALTH, "ship"], ["kubectl rollout status deploy/web", "ship"], ["fly status", "ship"], ["vercel inspect https://x.vercel.app", "ship"], ["gh run watch 991 --exit-status", "ship"], ["gh run view 991", "ship"]] as const) {
    assert.equal(readOnlyCheck(skill(cmd, job)), true, cmd);
  }
  assert.equal(readOnlyCheck(skill("gcloud run deploy shop-api --source .", "ship")), false);
});
