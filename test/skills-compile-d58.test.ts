/**
 * D58: real runs mix the job with investigation elsewhere, so a run's
 * essential steps are its successful step parts that ran inside the repo, in
 * order (a); steps that ran outside it are left out and listed in the draft
 * instead of refusing the run (b); a part too long to keep is a work marker
 * (c, g3's run sheets); a polling loop becomes the wait step (d); an inline
 * script is a step only when it is one line that starts a program (e).
 */
process.env.TZ = "UTC";
import { test } from "node:test";
import assert from "node:assert/strict";
import { compileRun, draftText, refusalWords, type CompileOpts, type CompileResult } from "../src/skills/compile.js";
import { statementsOf } from "../src/skills/compile-split.js";
import { renderSkillMd } from "../src/skills/skillmd.js";
import { skillProblems } from "../src/skills/validate.js";
import { callKind } from "../src/trace/checks.js";
import { redactSecrets } from "../src/trace/redact.js";
import { isMultiLine } from "../src/trace/shell.js";
import type { CheckHit, JobClass, RunCall, RunSheet } from "../src/trace/types.js";
import type { CompiledSkill } from "../src/skills/types.js";

const HOME = "/home/dev";
const ROOT = "/home/dev/src/shop";
const KEY = "github.com/acme/shop";
const CTX = { repoRoot: ROOT, home: HOME, job: null };

let seq = 0;
function call(raw: string, o: Partial<RunCall> & { job?: JobClass | null } = {}): RunCall {
  seq++;
  const { job = null, ...rest } = o;
  const red = redactSecrets(raw);
  return {
    id: `toolu_${String(seq).padStart(3, "0")}`, at: new Date(Date.UTC(2026, 9, 27, 10, 31) + seq * 20_000).toISOString(), cmd: red.cmd,
    ...(red.secret ? { secret: red.secret } : {}), key: KEY, cwd: "", bg: false, failed: false, isError: false,
    ...(raw.length > 2000 ? { truncated: true } : {}), ...(isMultiLine(raw) ? { multiLine: true } : {}),
    kind: callKind(raw, job), src: { use: seq * 1000, result: seq * 1000 + 400 }, ...rest,
  };
}
function sheet(calls: RunCall[], o: Partial<RunSheet> = {}): RunSheet {
  return {
    v: 1, id: "r-1027-d58a", session: "a1b2c3d4e5f6", repoKey: KEY, branch: "main", host: "claude", tier: "A", epoch: 1,
    startedAt: "2026-10-27T10:31:00Z", endedAt: "2026-10-27T10:40:00Z", job: null, jobWords: [], sharedWords: [], promptParams: {},
    calls, checkIndex: null, checked: false, end: "done",
    counts: { commands: calls.length, failed: calls.filter((c) => c.failed).length, toolCalls: calls.length, edits: 0 },
    helpers: [], skillId: null, ...o,
  };
}
const passed = (family: CheckHit["family"], facts: CheckHit["facts"] = {}): CheckHit => ({ family, passed: true, facts });
const OPTS: CompileOpts = { repoRoot: ROOT, home: HOME, platform: "darwin", moment: "asked", applies: KEY, taken: () => false };
const compile = (s: RunSheet, o: Partial<CompileOpts> = {}) => compileRun(s, { ...OPTS, ...o });
function ok(r: CompileResult): CompiledSkill {
  if (!r.ok) assert.fail(`refused ${r.reason}: ${r.detail}`);
  assert.deepEqual(skillProblems(renderSkillMd(r.skill), r.skill.name), []);
  return r.skill;
}
function refused(r: CompileResult, reason: string): string {
  assert.equal(r.ok, false, "should refuse");
  if (r.ok) return "";
  assert.equal(r.reason, reason, r.detail);
  return r.detail;
}
const brief = (cmd: string, cwd = "") => statementsOf(cmd, cwd, CTX).map((x) => [x.text, x.kind, ...(x.blocked ? [x.blocked] : [])]);

// ---------------------------------------------------------------- (a) and (b)

test("D58 a/b: steps that ran outside the repo are left out and listed with where they ran; the rest is kept, in order", () => {
  const s = sheet([
    call("npm run build"),
    call("go test ./...", { cwd: null, key: "github.com/acme/api" }),
    call("make dist", { cwd: null, key: null }),
    call("ls ../api", { cwd: null, key: "github.com/acme/api" }),
    call("npm test"),
  ]);
  const c = ok(compile(s));
  assert.deepEqual(c.steps.map((x) => x.cmd), ["npm run build", "npm test"]);
  assert.deepEqual(c.elsewhere, [{ cmd: "go test ./...", where: "in api" }, { cmd: "make dist", where: "outside any repo" }]);
  // A look elsewhere is a look: counted, not listed.
  assert.deepEqual(c.leftOut, { failed: 0, lookOnly: 1, duplicates: 0, plumbing: 0, work: 0 });
  const d = draftText(c, s);
  assert.match(d, /^ {2}left out {2}3 commands: 1 that only looked around, 2 that ran outside this repo$/m);
  assert.match(d, /^ {2}elsewhere {2}go test \.\/\.\.\. \(in api\)$/m);
  assert.match(d, /^ {2}elsewhere {2}make dist \(outside any repo\)$/m);
});

test("D58 b: a cd out of the repo inside a call leaves out what follows it, not the whole run", () => {
  const c = ok(compile(sheet([call("npm run build\ncd /srv/other\nnpm test\nmake dist")])));
  assert.deepEqual(c.steps.map((x) => x.cmd), ["npm run build"]);
  assert.deepEqual(c.elsewhere, [
    { cmd: "npm test", where: "in a folder Trail couldn't follow" },
    { cmd: "make dist", where: "in a folder Trail couldn't follow" },
  ]);
});

test("D58 b: what runs elsewhere is only left out, whatever it holds; the listing shows home paths as $HOME and no secret", () => {
  const c = ok(compile(sheet([
    call("npm run build"),
    call("python3 - <<'EOF'\nimport subprocess\nsubprocess.run(['make'])\nEOF", { cwd: null, key: null }),
    call("VER=$(cat VERSION)\nnpm publish acme-$VER.tgz", { cwd: null, key: "github.com/acme/cli" }),
    call("node /home/dev/tools/gen.mjs --out /home/dev/tools/out", { cwd: null, key: null }),
    call(`curl -H "Authorization: Bearer ${["eyJhbGciOiJIUzI1NiJ9", "eyJzdWIiOiJ4In0", "c2lnbmF0dXJlMTIzNDU2"].join(".")}" https://api.example.test/x`, { cwd: null, key: null }),
  ])));
  assert.deepEqual(c.steps.map((x) => x.cmd), ["npm run build"]);
  const shown = c.elsewhere!.map((e) => e.cmd);
  assert.ok(shown.includes("node $HOME/tools/gen.mjs --out $HOME/tools/out"), shown.join("\n"));
  assert.ok(shown.includes("a command Trail can't show (it held a secret)"), shown.join("\n"));
  assert.doesNotMatch(shown.join("\n"), /\/home\/dev|eyJ/);
});

test("D58 b: no step left inside the repo, or a check that ran outside it: no skill, and the words say where", () => {
  const d = refused(compile(sheet([call("git status"), call("npm test", { cwd: null, key: "github.com/acme/api" })])), "outside-repo");
  assert.equal(refusalWords("outside-repo", d), "a step ran outside this repo: `npm test`");
  const tests = (cwd: string | null) => sheet([
    call("npm run build"),
    call("npm test", { cwd, key: cwd === null ? "github.com/acme/api" : KEY, job: "tests", check: passed("tests") }),
  ], { job: "tests", checkIndex: 1, checked: true });
  refused(compile(tests(null)), "outside-repo");
  const c = ok(compile(tests("")));
  assert.equal(c.check, "npm test");
  const npmView = sheet([
    call("npm publish acme-1.4.2.tgz"),
    call("npm view acme version", { cwd: null, key: null, job: "release", check: passed("npm-view", { version: "1.4.2" }), tail: "1.4.2" }),
  ], { job: "release", checkIndex: 1, checked: true });
  refused(compile(npmView, { moment: "repeated" }), "outside-repo");
});

test("D58 a: a retried step keeps only its last success, with every id; failures and repeats are counted", () => {
  const b1 = call("npm run build");
  const p1 = call("npm publish acme-1.4.2.tgz", { failed: true, errorLine: "npm error code EOTP" });
  const b2 = call("npm run build");
  const p2 = call("npm publish acme-1.4.2.tgz");
  const c = ok(compile(sheet([b1, p1, b2, p2])));
  assert.deepEqual(c.steps.map((x) => [x.cmd, x.from]), [["npm run build", [b1.id, b2.id]], ["npm publish acme-{version}.tgz", [p2.id]]]);
  assert.deepEqual([c.leftOut.failed, c.leftOut.duplicates], [1, 1]);
});

// ---------------------------------------------------------------- (c)

test("D58 c: a long call is read from its pieces; a piece too long to keep is work, left out and counted, never a refusal", () => {
  // g3's run sheet: a call over 2,000 characters keeps its top-level pieces; a piece over 2,000 is a marker.
  const long: RunCall = {
    ...call("x"), cmd: null, truncated: true, multiLine: true, kind: "step",
    parts: [
      { cmd: "npm ci", sep: "&&", kind: "step" },
      { cmd: null, sep: "&&", kind: "work", long: true },
      { cmd: "git status --short", sep: ";", kind: "look" },
      { cmd: "go test ./internal/...", sep: "", kind: "step" },
    ],
  };
  const c = ok(compile(sheet([call("npm run build"), long])));
  assert.deepEqual(c.steps.map((x) => x.cmd), ["npm run build", "npm ci", "go test ./internal/..."]);
  assert.deepEqual(c.steps.slice(1).map((x) => x.from), [[long.id], [long.id]]);
  assert.equal(c.leftOut.work, 1);
  // A pipeline that fed or read the long piece goes with it.
  const piped: RunCall = { ...long, id: "toolu_piped", parts: [
    { cmd: "npm run build", sep: ";", kind: "step" }, { cmd: "cat data.json", sep: "|", kind: "look" }, { cmd: null, sep: "", kind: "work", long: true },
  ] };
  assert.deepEqual(ok(compile(sheet([piped]))).steps.map((x) => x.cmd), ["npm run build"]);
  // A piece that held a secret Trail couldn't name refuses, as a short call would; a named one runs from its variable.
  const secret: RunCall = { ...long, secret: "refused", parts: [{ cmd: "npm ci", sep: "&&", kind: "step" }, { cmd: null, sep: "", kind: "step", secret: "refused" }] };
  refused(compile(sheet([call("npm run build"), secret])), "secret");
  // Only long pieces: work, left out, and no skill from it alone.
  const onlyLong: RunCall = { ...long, kind: "work", parts: [{ cmd: null, sep: "", kind: "work", long: true }] };
  const d = ok(compile(sheet([call("npm run build"), onlyLong])));
  assert.deepEqual([d.steps.length, d.leftOut.work], [1, 1]);
});

// ---------------------------------------------------------------- (d)

const WAIT = 'do [ $((SECONDS-s)) -ge 300 ] && echo "not ready after 5 min" && break; sleep 10; done';

test("D58 d: a polling loop over several lines becomes the 4.5 wait step: a value it waits for, or a command that starts to work", () => {
  const token = call("for i in $(seq 1 30); do\n  s=$(gh api repos/acme/shop/commits/4e1c9a2/statuses --jq '.[0].state')\n  echo \"$i $s\"\n  [ \"$s\" = \"success\" ] && break\n  sleep 10\ndone");
  const plain = call("for i in $(seq 1 40); do\n  curl -sf -o /dev/null http://localhost:3000/ && { echo up; break; }\n  sleep 1\ndone");
  const until = call("until docker info >/dev/null 2>&1; do\n  sleep 2\ndone");
  const whileNot = call("while ! curl -sf http://localhost:3000/health >/dev/null; do\n  sleep 2\ndone", { cwd: "web" });
  const c = ok(compile(sheet([call("docker compose up -d"), until, call("npm run dev", { bg: true }), whileNot, plain, call("git push origin 4e1c9a2:refs/heads/beta"), token])));
  assert.deepEqual(c.steps.map((x) => [x.cmd, x.wait]), [
    ["docker compose up -d", false],
    [`s=$SECONDS; until docker info >/dev/null 2>&1; ${WAIT}`, true],
    ["npm run dev", false],
    [`s=$SECONDS; until (cd web && curl -sf http://localhost:{port}/health) >/dev/null 2>&1; ${WAIT}`, true],
    [`s=$SECONDS; until curl -sf -o /dev/null http://localhost:{port}/ >/dev/null 2>&1; ${WAIT}`, true],
    ["git push origin {sha}:refs/heads/beta", false],
    [`s=$SECONDS; until [ "$(gh api repos/acme/shop/commits/{sha}/statuses --jq '.[0].state')" = "success" ]; ${WAIT}`, true],
  ]);
  assert.deepEqual(c.steps.map((x) => x.from), [[c.steps[0]!.from![0]], [until.id], [c.steps[2]!.from![0]], [whileNot.id], [plain.id], [c.steps[5]!.from![0]], [token.id]]);
  assert.match(renderSkillMd(c), /^7\. `s=\$SECONDS; until \[ .*done` \(a wait: run it in the background if it may take over 2 minutes\)$/m);
});

test("D58 d: one-line polling loops wait the same way; a loop that is not a poll stays as it was", () => {
  assert.deepEqual(brief("for i in $(seq 1 40); do curl -sf -o /dev/null http://localhost:3000 && break; sleep 0.5; done"), [["curl -sf -o /dev/null http://localhost:3000", "step"]]);
  assert.deepEqual(brief('until [ "$(npx vercel ls 2>/dev/null | grep -o \'Ready\' | head -1)" = "Ready" ]; do sleep 10; done'), [["npx vercel ls 2>/dev/null | grep -o 'Ready' | head -1", "step"]]);
  // No sleep, or more than one thing done each time round, or the loop's own variable used: not a poll.
  assert.deepEqual(brief("for f in a b; do\n  npm run build:$f\ndone")[0]!.at(-1), "runs over more than one line");
  assert.deepEqual(brief("for i in 1 2 3; do\n  npm run seed\n  curl -sf http://localhost:3000/ && break\n  sleep 1\ndone")[0]!.at(-1), "runs over more than one line");
  assert.deepEqual(brief("for i in 1 2 3; do\n  curl -sf http://localhost:300$i/ && break\n  sleep 1\ndone")[0]!.at(-1), "runs over more than one line");
  // A variable set before the loop is still a variable set on an earlier line.
  assert.deepEqual(brief('K=$(cat key.txt)\nuntil curl -sf -H "Authorization: Bearer $K" https://api.example.test/x; do\n  sleep 5\ndone').at(-1)!.at(-1), "uses $K, set on an earlier line");
  // A wait on the run's check is the check, polled once.
  const loop = call("for i in $(seq 1 20); do\n  gh pr checks 12 | grep -q pending || break\n  sleep 30\ndone\ngh pr checks 12", { job: "ship", check: passed("gh-checks", { pr: "12" }) });
  const c = ok(compile(sheet([call("git push origin fix/retry"), loop], { checkIndex: 1, checked: true, job: "ship" }), { moment: "repeated" }));
  assert.equal(c.check, "gh pr checks {pr}");
});

// ---------------------------------------------------------------- (e)

test("D58 e: an inline script is a look or work (D51) unless it is one line that starts a program", () => {
  assert.deepEqual(brief("python3 - <<'EOF'\nimport subprocess\nsubprocess.run(['make', 'dist'])\nEOF"), [["python3 - <<'EOF'", "work"]]);
  assert.deepEqual(brief("node -e '\nconst { execSync } = require(\"child_process\");\nexecSync(\"npm run build\")\n'"), [["node -e '\nconst { execSync } = require(\"child_process\");\nexecSync(\"npm run build\")\n'", "work"]]);
  assert.deepEqual(brief("python3 - <<'EOF'\nimport json\nprint(json.load(open('package.json'))['version'])\nEOF"), [["python3 - <<'EOF'", "look"]]);
  assert.deepEqual(brief(`python3 -c 'import subprocess; subprocess.run(["make", "dist"])'`), [[`python3 -c 'import subprocess; subprocess.run(["make", "dist"])'`, "step"]]);
  assert.deepEqual(brief(`node -e "require('./scripts/release.js')"`), [[`node -e "require('./scripts/release.js')"`, "step"]]);
  assert.deepEqual(brief(`python3 -c "import urllib.request; print(urllib.request.urlopen('https://api.example.test/x').read())"`), [[`python3 -c "import urllib.request; print(urllib.request.urlopen('https://api.example.test/x').read())"`, "look"]]);
  // A shell heredoc is a script, not an inline program: it still refuses.
  assert.deepEqual(brief("bash <<'EOF'\nnpm test\nEOF")[0]!.at(-1), "runs a script written inline (a heredoc)");
  // In a run: the heredoc is left out and counted, the steps around it kept; heredocs alone give no skill.
  const c = ok(compile(sheet([call("npm run build"), call("python3 - <<'EOF'\nimport subprocess\nsubprocess.run(['make', 'dist'])\nEOF"), call("npm test")])));
  assert.deepEqual(c.steps.map((x) => x.cmd), ["npm run build", "npm test"]);
  assert.equal(c.leftOut.work, 1);
  refused(compile(sheet([call("python3 - <<'EOF'\nimport subprocess\nsubprocess.run(['make', 'dist'])\nEOF")])), "no-steps");
});

// ---------------------------------------------------------------- g3's interfaces (D56a push check, essentialSteps)

test("a push that moved the branch is the check and a step (D56a); the check says what moves", () => {
  const s = sheet([
    call("npm run build"),
    call("git push origin HEAD:refs/heads/prod", { job: "ship", check: passed("push", { sha: "9f8e7d6", branch: "prod", remote: "origin" }), tail: "   4e1c9a2..9f8e7d6  HEAD -> prod" }),
  ], { job: "ship", checkIndex: 1, checked: true });
  const c = ok(compile(s, { moment: "repeated" }));
  assert.deepEqual(c.steps.map((x) => [x.cmd, x.gated]), [["npm run build", null], ["git push origin HEAD:refs/heads/prod", "push-prod"]]);
  assert.equal(c.check, "git push origin HEAD:refs/heads/prod");
  assert.equal(c.checkIsStep, true);
  assert.equal(c.checkShows, 'prod moved: git prints old..new -> prod, not "Everything up-to-date"');
  assert.match(renderSkillMd(c), /^Step 2, `git push origin HEAD:refs\/heads\/prod`, is the check: prod moved/m);
  // A branch that is a param is shown as the param.
  const f = sheet([
    call("git checkout -b fix/cart"),
    call("git push -u origin fix/cart", { check: passed("push", { sha: "9f8e7d6", branch: "fix/cart", remote: "origin" }) }),
  ], { checkIndex: 1, checked: true });
  assert.match(ok(compile(f)).checkShows ?? "", /^\{branch\} moved: git prints old\.\.new -> \{branch\}/);
});

test("a step in another checkout (its own key, a folder inside it) is left out like any step elsewhere, as the run verdict reads it", () => {
  // g3's fold gives a call in another repo that repo's key and a cwd inside it, not null.
  const c = ok(compile(sheet([call("npm run build"), call("go test ./...", { key: "github.com/acme/api", cwd: "" }), call("npm test")])));
  assert.deepEqual(c.steps.map((x) => x.cmd), ["npm run build", "npm test"]);
  assert.deepEqual(c.elsewhere, [{ cmd: "go test ./...", where: "in api" }]);
  refused(compile(sheet([call("git status"), call("make", { key: "github.com/acme/api", cwd: "" })])), "outside-repo");
});

test("a log written into a scratch folder is where the output went, not what ran: the redirect goes, the step stays (g2 recount)", () => {
  const c = ok(compile(sheet([
    call("npm run dev > /tmp/trail-dev.log 2>&1 &"),
    call("go test ./... 2>&1 | tee /private/tmp/claude-501/x/scratchpad/test.log"),
    call('npm run build >> "/tmp/build.log"'),
  ], { job: "run-local" })));
  assert.deepEqual(c.steps.map((x) => [x.cmd, x.bg]), [["npm run dev", true], ["go test ./...", false], ["npm run build", false]]);
  // Reading a scratch file, or writing a result there that a later step uses, still refuses.
  refused(compile(sheet([call("node build.mjs --out /tmp/x/out.json")])), "scratch-path");
  refused(compile(sheet([call("psql -h localhost -f /tmp/x/q.sql > /tmp/x/out.csv")])), "scratch-path");
});
