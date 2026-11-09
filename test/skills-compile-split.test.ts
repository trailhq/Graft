/**
 * One Bash call read statement by statement (compile-split.ts): agents send
 * small scripts in one call, and a top-level newline separates commands the
 * way `;` does. Steps stay word for word what ran; a step that leans on an
 * earlier line (a variable, `source`, a heredoc it opened) refuses the skill.
 */
process.env.TZ = "UTC";
import { test } from "node:test";
import assert from "node:assert/strict";
import { compileRun, refusalWords, type CompileOpts, type CompileResult } from "../src/skills/compile.js";
import { splitSheet, statementsOf } from "../src/skills/compile-split.js";
import { callKind } from "../src/trace/checks.js";
import { isMultiLine, stepMatches } from "../src/trace/shell.js";
import type { CheckHit, JobClass, RunCall, RunSheet } from "../src/trace/types.js";

const HOME = "/home/dev";
const ROOT = "/home/dev/src/acme-cli";
const KEY = "github.com/acme/acme-cli";
const CTX = { repoRoot: ROOT, home: HOME, job: null };

let seq = 0;
function call(raw: string, o: Partial<RunCall> & { job?: JobClass | null } = {}): RunCall {
  seq++;
  const { job = null, ...rest } = o;
  return {
    id: `toolu_${String(seq).padStart(3, "0")}`, at: new Date(Date.UTC(2026, 9, 27, 10, 31) + seq * 20_000).toISOString(), cmd: raw,
    key: KEY, cwd: "", bg: false, failed: false, isError: false,
    ...(raw.length > 2000 ? { truncated: true } : {}), ...(isMultiLine(raw) ? { multiLine: true } : {}),
    kind: callKind(raw, job), src: { use: seq * 1000, result: seq * 1000 + 400 }, ...rest,
  };
}
function sheet(calls: RunCall[], o: Partial<RunSheet> = {}): RunSheet {
  return {
    v: 1, id: "r-1027-5b2c", session: "a1b2c3d4e5f6", repoKey: KEY, branch: "main", host: "claude", tier: "A", epoch: 1,
    startedAt: "2026-10-27T10:31:00Z", endedAt: "2026-10-27T10:40:00Z", job: null, jobWords: [], sharedWords: [], promptParams: {},
    calls, checkIndex: null, checked: false, end: "done",
    counts: { commands: calls.length, failed: calls.filter((c) => c.failed).length, toolCalls: calls.length, edits: 0 },
    helpers: [], skillId: null, ...o,
  };
}
const passed = (family: CheckHit["family"], facts: CheckHit["facts"] = {}): CheckHit => ({ family, passed: true, facts });
const OPTS: CompileOpts = { repoRoot: ROOT, home: HOME, platform: "darwin", moment: "asked", applies: KEY, taken: () => false };
const compile = (s: RunSheet) => compileRun(s, OPTS);
const brief = (cmd: string, cwd = "") => statementsOf(cmd, cwd, CTX).map((x) => [x.text, x.cwd, x.kind, ...(x.bg ? ["bg"] : []), ...(x.blocked ? [x.blocked] : [])]);
function ok(r: CompileResult) {
  if (!r.ok) assert.fail(`refused ${r.reason}: ${r.detail}`);
  return r.skill;
}
function refused(r: CompileResult, reason: string): string {
  assert.equal(r.ok, false, "should refuse");
  if (r.ok) return "";
  assert.equal(r.reason, reason, r.detail);
  return r.detail;
}

test("statements: echo headers, comments and shell options go; a cd on its own line moves the folder after it", () => {
  const cmd = [
    'echo "=== build ==="', "set -euo pipefail", "# build, then pack the cli", "npm run build",
    "cd packages/cli || exit 1", "npm pack", "cd ../..", "git status --short",
  ].join("\n");
  assert.deepEqual(brief(cmd), [
    ['echo "=== build ==="', "", "plumbing"],
    ["npm run build", "", "step"],
    ["npm pack", "packages/cli", "step"],
    ["git status --short", "", "look"],
  ]);
  // `cd X && cmd` moves the script's shell too, not only cmd; pushd and popd.
  assert.deepEqual(brief("npm test\ncd ../api && npm test\nnpm run lint\npushd ../docs\nmake html\npopd\nmake check", "web"), [
    ["npm test", "web", "step"], ["npm test", "api", "step"], ["npm run lint", "api", "step"], ["make html", "docs", "step"], ["make check", "api", "step"],
  ]);
  // The leading cds were already read into the call's folder.
  assert.deepEqual(brief("cd web || exit 1\nnpm test", "web"), [["npm test", "web", "step"]]);
});

test("statements: a cd out of the repo, home or unknown leaves the folder unknown", () => {
  // (A cd on the call's first line is the fold's: it is in the call's folder already.)
  assert.deepEqual(brief("npm run build\ncd /srv/other\nnpm test"), [["npm run build", "", "step"], ["npm test", null, "step"]]);
  // A worktree under the repo is another checkout.
  assert.deepEqual(brief("npm run build\ncd .claude/worktrees/fix-x/apps/web && npm test").at(-1), ["npm test", null, "step"]);
  assert.deepEqual(brief("npm run build\ncd ~/code/other && npm test").at(-1), ["npm test", null, "step"]);
  assert.deepEqual(brief('npm run build\ncd "$WORKDIR"\nnpm test').at(-1), ["npm test", null, "step"]);
  assert.deepEqual(brief("npm run build\ncd -\nnpm test").at(-1), ["npm test", null, "step"]);
  // Once unknown, a relative cd can't bring it back.
  assert.deepEqual(brief("npm run build\ncd /srv/other\ncd web\nnpm test").at(-1), ["npm test", null, "step"]);
  // A variable set in the call is followed; an absolute path back inside the repo is fine.
  assert.deepEqual(brief(`APP=${ROOT}/apps/web\ncd "$APP"\nnpm test`), [["npm test", "apps/web", "step"]]);
  assert.deepEqual(brief(`npm run build\ncd ${ROOT}/apps/web\nnpm test`).at(-1), ["npm test", "apps/web", "step"]);
});

test("statements: a plain variable is written into the steps that use it; a plain export goes on each later step's line", () => {
  assert.deepEqual(brief("VER=1.4.2\nnpm publish acme-cli-$VER.tgz && git tag v${VER}"), [["npm publish acme-cli-1.4.2.tgz && git tag v1.4.2", "", "step"]]);
  assert.deepEqual(brief("export DOCKER_HOST=unix://$HOME/.colima/default/docker.sock TESTCONTAINERS_RYUK_DISABLED=true\ncd backend\ngo test -tags integration ./internal/workflow/... 2>&1 | tail -40"), [
    ["DOCKER_HOST=unix://$HOME/.colima/default/docker.sock TESTCONTAINERS_RYUK_DISABLED=true go test -tags integration ./internal/workflow/... 2>&1 | tail -40", "backend", "step"],
  ]);
  // A step's own prefix wins; $HOME and $PATH stay as they are.
  assert.deepEqual(brief('export GOFLAGS=-mod=mod PATH="$HOME/go/bin:$PATH"\nGOFLAGS=-v go vet ./...'), [['PATH="$HOME/go/bin:$PATH" GOFLAGS=-v go vet ./...', "", "step"]]);
  // A loop or an if can't take a prefix: it needs its shell set up, and is blocked.
  assert.deepEqual(brief("export DOCKER_HOST=unix://$HOME/.colima/default/docker.sock\nif docker info >/dev/null; then docker compose up -d; fi")[0]!.at(-1), "needs its shell set up first (`export DOCKER_HOST=unix://$HOME/.colima/default/docker.sock`)");
  // A named secret's placeholder is plain too: the step runs from the variable (4.10).
  assert.deepEqual(brief('export NPM_TOKEN="${NPM_TOKEN:?set NPM_TOKEN}"\nnpm publish'), [['NPM_TOKEN="${NPM_TOKEN:?set NPM_TOKEN}" npm publish', "", "step"]]);
  // A scratch folder in a variable is a scratch path in the step (compile then refuses it as one).
  assert.deepEqual(brief('SB=/tmp/x/scratchpad\nnode build.mjs --out "$SB/out.json"'), [['node build.mjs --out "/tmp/x/scratchpad/out.json"', "", "step"]]);
});

test("statements: a step that uses a variable set by a command or with spaces, or needs its shell set up, is blocked", () => {
  assert.deepEqual(brief('VER=$(node -p "require(\'./package.json\').version")\nnpm publish acme-cli-$VER.tgz'), [["npm publish acme-cli-$VER.tgz", "", "step", "uses $VER, set on an earlier line"]]);
  assert.deepEqual(brief('UA="Mozilla/5.0 Test"\ncurl -s -A "$UA" https://example.test/'), [['curl -s -A "$UA" https://example.test/', "", "step", "uses $UA, set on an earlier line"]]);
  assert.deepEqual(brief('read -r SHA <<< "$(git rev-parse HEAD)"\ngit push origin ${SHA}:refs/heads/beta').at(-1), ["git push origin ${SHA}:refs/heads/beta", "", "step", "uses $SHA, set on an earlier line"]);
  // Inside single quotes it is not a variable; one the call never set (HOME, PATH) is fine.
  assert.deepEqual(brief("VER=$(date +%s)\nnpm pkg get version --json | jq '$VER'\nls $HOME/.cache"), [
    ["npm pkg get version --json | jq '$VER'", "", "step"], ["ls $HOME/.cache", "", "look"],
  ]);
  assert.deepEqual(brief("source .env\nnpm run deploy:check"), [["npm run deploy:check", "", "step", "needs its shell set up first (`source .env`)"]]);
  assert.deepEqual(brief("export KEY=$(cat key.txt)\nnpm run build")[0]!.at(-1), "needs its shell set up first (`export KEY=$(cat key.txt)`)");
  assert.deepEqual(brief("set -a\nnpm run build")[0]!.at(-1), "needs its shell set up first (`set -a`)");
  // A look after setup is not a step, so nothing is blocked.
  assert.deepEqual(brief("source .env\ngit status --short"), [["git status --short", "", "look"]]);
});

test("statements: interpreter heredocs are a look when they only read, work when they write or run programs (D51, D58 e); a shell heredoc is a blocked step", () => {
  const py = (body: string) => `python3 - <<'EOF'\n${body}\nEOF`;
  assert.deepEqual(brief(`${py('import json\nprint(json.load(open("package.json"))["version"])')}\nnpm test`), [
    ["python3 - <<'EOF'", "", "look"], ["npm test", "", "step"],
  ]);
  assert.deepEqual(brief(py('import json\nopen("out.json", "w").write(json.dumps({}))')), [["python3 - <<'EOF'", "", "work"]]);
  assert.deepEqual(brief(`node - <<'EOF'\nrequire("fs").writeFileSync("x.json", "{}")\nEOF`), [["node - <<'EOF'", "", "work"]]);
  assert.deepEqual(brief(py('import subprocess\nsubprocess.run(["npm", "publish"])')), [["python3 - <<'EOF'", "", "work"]]);
  assert.deepEqual(brief("bash <<'EOF'\nnpm test\nEOF"), [["bash <<'EOF'", "", "step", "runs a script written inline (a heredoc)"]]);
  assert.deepEqual(brief("cat > notes.txt <<'EOF'\nhello\nEOF"), [["cat > notes.txt <<'EOF'", "", "work"]]);
});

test("statements: a & ends a statement that runs in the background; a loop over lines is blocked", () => {
  assert.deepEqual(brief("npm run dev > dev.log 2>&1 &\nsleep 5\ncurl -s http://localhost:3000/health"), [
    ["npm run dev > dev.log 2>&1", "", "step", "bg"], ["sleep 5", "", "plumbing"], ["curl -s http://localhost:3000/health", "", "step"],
  ]);
  assert.deepEqual(brief("for i in 1 2 3; do\n  curl -s http://localhost:3000/health\ndone"), [
    ["for i in 1 2 3; do\n  curl -s http://localhost:3000/health\ndone", "", "step", "runs over more than one line"],
  ]);
  // An inline script over several lines is read as a heredoc (D58 e): it starts a program, so work, left out.
  assert.equal(brief("node -e '\nrequire(\"./scripts/release.js\")\n'")[0]!.at(-1), "work");
});

test("links: echo headers and looks chained with && or ; go; steps chained with nothing between stay one step", () => {
  assert.deepEqual(brief('echo "=== tag ===" && git tag v1.4.2 -m "release; notes" && git push origin v1.4.2 && echo "=== done ==="'), [
    ['echo "=== tag ==="', "", "plumbing"], ['git tag v1.4.2 -m "release; notes" && git push origin v1.4.2', "", "step"], ['echo "=== done ==="', "", "plumbing"],
  ]);
  assert.deepEqual(brief("git fetch -q origin; git log --oneline -3; npm ci && git status --short && npm run build"), [
    ["git fetch -q origin", "", "step"], ["git log --oneline -3", "", "look"], ["npm ci", "", "step"], ["git status --short", "", "look"], ["npm run build", "", "step"],
  ]);
  // A commit between steps is work: left out, the push kept.
  assert.deepEqual(brief('git add -A && git commit -m "fix: retry" && git push origin beta').map((x) => x[2]), ["work", "work", "step"]);
  // Commands that only report on the machine are looks, whatever the trace calls them.
  assert.deepEqual(brief("date; uname -a; docker ps -a | grep db; node --version; npm test").map((x) => x[2]), ["look", "look", "look", "look", "step"]);
  // A gh api read, a version check, docker with a context: looks. A gh api write is not.
  assert.deepEqual(brief("gh api repos/acme/shop/commits/4e1c9a2/statuses --jq '.[0].state'; gh api repos/acme/shop/issues/3/labels -f labels=x; npx --no-install vitest --version 2>/dev/null; docker --context default ps -q | wc -l; gh repo list acme --limit 5").map((x) => x[2]), ["look", "step", "look", "look", "look"]);
  assert.deepEqual(brief("acme --help 2>&1; acme deploy --help; acme deploy --prod").map((x) => x[2]), ["look", "look", "step"]);
  // An inline script is read like a heredoc (D51): it prints, it writes, or it runs code.
  assert.deepEqual(brief(`node -p "require('./package.json').version"; npm view acme-cli time --json | node -e 'const t=JSON.parse(require("fs").readFileSync(0)); console.log(Object.keys(t).length)'; node -e "require('fs').writeFileSync('x.json', '{}')"; node -e "require('./scripts/release.js')"; python3 -c 'import subprocess; subprocess.run(["make"])'`).map((x) => x[2]), ["look", "look", "work", "step", "step"]);
  // Opening a file to look at it is a look; starting an app is not.
  assert.deepEqual(brief("open docs/design.html; open -a Docker").map((x) => x[2]), ["look", "step"]);
});

test("links: a test that guards a step stays with it; a && b || c stays whole; cd X || { ...; exit 1; } is a cd", () => {
  assert.deepEqual(brief("[ -f .env.example ] && npm run setup"), [["[ -f .env.example ] && npm run setup", "", "step"]]);
  assert.deepEqual(brief("command -v pnpm && pnpm install; grep -q x README.md"), [["command -v pnpm && pnpm install", "", "step"], ["grep -q x README.md", "", "look"]]);
  assert.deepEqual(brief("npm ci && npm run build || npm run build:fallback"), [["npm ci && npm run build || npm run build:fallback", "", "step"]]);
  assert.deepEqual(brief('npm run build\ncd web 2>/dev/null || { echo "no web"; exit 1; }\nnpm test'), [["npm run build", "", "step"], ["npm test", "web", "step"]]);
  // A subshell's cd is that step's folder only (compile writes it back as `(cd web && npm test)`).
  assert.deepEqual(brief("(cd web && npm test)\nnpm run lint"), [["npm test", "web", "step"], ["npm run lint", "", "step"]]);
});

test("groups: a { ... } or ( ... ) block with only output filters after it is read inside; a subshell's cd stays inside", () => {
  assert.deepEqual(brief('{\n  echo "### build"; npm run build 2>&1 | tail -3\n  echo "### test"; npm test\n} 2>&1 | tail -20').filter((x) => x[2] === "step"), [
    ["npm run build 2>&1 | tail -3", "", "step"], ["npm test", "", "step"],
  ]);
  assert.deepEqual(brief("(\n  cd web\n  npm test\n)\nnpm run lint"), [["npm test", "web", "step"], ["npm run lint", "", "step"]]);
  // A block in the background: its last step stays in the background.
  assert.deepEqual(brief('{\n  npm run build\n  npm test\n} > build.log 2>&1 &\necho started').filter((x) => x[2] === "step"), [
    ["npm run build", "", "step"], ["npm test", "", "step", "bg"],
  ]);
  // A subshell piped into a program is that program's input, not a block: design 4.5's publish stays whole.
  assert.deepEqual(brief("pkill -f x; sleep 1\n(sleep 15; printf '\\n'; sleep 300) | script -q /dev/null npm publish").filter((x) => x[2] === "step"), [
    ["pkill -f x", "", "step"], ["(sleep 15; printf '\\n'; sleep 300) | script -q /dev/null npm publish", "", "step"],
  ]);
});

test("links: an absolute cd into the repo finds the folder even when the call's was unknown", () => {
  assert.deepEqual(brief(`echo hi\ncd ${ROOT}/web && npm test`, null as unknown as string), [["echo hi", null, "plumbing"], ["npm test", "web", "step"]]);
});

test("splitSheet: a one-line check call of several commands keeps only its check; a one-command call is left as it is", () => {
  const chk = call('echo "local: $(git rev-parse --short HEAD)"; npm view acme-cli version', { kind: "look", check: passed("npm-view", { version: "1.4.2" }), tail: "1.4.2" });
  const one = call("npm run build 2>&1 | tail -5");
  const { sheet: s } = splitSheet(sheet([one, chk], { checkIndex: 1, job: "release" }), OPTS);
  assert.equal(s.calls[0], one);
  assert.deepEqual(s.calls.slice(1).map((c) => c.cmd), ['echo "local: $(git rev-parse --short HEAD)"', "npm view acme-cli version"]);
  assert.equal(s.checkIndex, 2);
  assert.equal(s.calls[2]!.tail, "1.4.2");
});

test("every split step still matches the call it came from, as the save gate reads it", () => {
  const raw = 'cd packages/cli || exit 1\necho "=== pack ==="\nnpm run build\nnpm pack 2>&1 | tail -3\ngit push origin main';
  for (const x of statementsOf(raw, "packages/cli", CTX).filter((s) => s.kind === "step")) {
    assert.ok(stepMatches(x.text, raw), x.text);
  }
});

test("splitSheet: the check line of a multi-line check call carries the check; failed and single-line calls stay whole", () => {
  const script = call('echo "=== test ==="\nnpm run build\nnpm test 2>&1 | tail -20', { job: "tests", check: passed("tests"), tail: "Tests: 41 passed" });
  const failed = call("npm run lint\nnpm test", { failed: true });
  const plain = call("git status --short");
  const { sheet: s } = splitSheet(sheet([failed, plain, script], { checkIndex: 2, job: "tests" }), OPTS);
  assert.deepEqual(s.calls.map((c) => c.cmd), ["npm run lint\nnpm test", "git status --short", 'echo "=== test ==="', "npm run build", "npm test 2>&1 | tail -20"]);
  assert.equal(s.checkIndex, 4);
  assert.deepEqual(s.calls[4]!.check, passed("tests"));
  assert.equal(s.calls[4]!.tail, "Tests: 41 passed");
  assert.equal(s.calls[3]!.check, undefined);
  assert.equal(s.calls[3]!.tail, undefined);
  assert.ok(s.calls.slice(2).every((c) => c.id === script.id && !c.multiLine));
});

test("splitSheet: a truncated call is split only when it holds no step and no heredoc; a background script keeps only its last step in the background", () => {
  const big = call(`echo "${"=".repeat(1990)}"\ngit status --short\nnpm run build`);
  assert.equal(big.truncated, true);
  assert.equal(splitSheet(sheet([big]), OPTS).sheet.calls.length, 1);
  const looks = call(`echo "${"=".repeat(1990)}"\ngit status --short`, { kind: "step" });
  assert.deepEqual(splitSheet(sheet([looks]), OPTS).sheet.calls.map((c) => c.kind), ["plumbing", "look"]);
  const bg = call("npm run build\nnpm start", { bg: true });
  const { sheet: s, blocked } = splitSheet(sheet([bg]), OPTS);
  assert.deepEqual(s.calls.map((c) => [c.cmd, c.bg, blocked.get(c)]), [["npm run build", false, undefined], ["npm start", true, undefined]]);
  const one = splitSheet(sheet([call('echo "=== dev ==="\nnpm run dev', { bg: true })]), OPTS).sheet;
  assert.deepEqual(one.calls.map((c) => c.bg), [false, true]);
});

test("compile: a release script in one call gives its steps, word for word, with the publish gated", () => {
  const c = compile(sheet([
    call("npm whoami"),
    call([
      'echo "=== release ==="', "set -e", "git pull --ff-only origin main", "npm ci", "npm run build",
      "npm pack 2>&1 | tail -3", "npm publish acme-cli-1.4.2.tgz --access public",
    ].join("\n")),
    call("npm view acme-cli version", { check: passed("npm-view", { version: "1.4.2" }), tail: "1.4.2" }),
  ], { job: "release", checkIndex: 2, checked: true, promptParams: { version: "1.4.2" } }));
  assert.ok(c.ok, c.ok ? "" : `${c.reason}: ${c.detail}`);
  if (!c.ok) return;
  assert.deepEqual(c.skill.steps.map((s) => [s.cmd, s.gated]), [
    ["git pull --ff-only origin main", null], ["npm ci", null], ["npm run build", null], ["npm pack", null],
    ["npm publish acme-cli-{version}.tgz --access public", "publish"],
  ]);
  assert.equal(c.skill.check, "npm view acme-cli version");
  // Every step came from the one call; nothing in it was left out as a separate call.
  assert.deepEqual([...new Set(c.skill.steps.flatMap((s) => s.from))], ["toolu_" + String(seq - 1).padStart(3, "0")]);
  // npm whoami (check first) and the npm view check are not steps.
  assert.deepEqual(c.skill.leftOut, { failed: 0, lookOnly: 2, duplicates: 0, plumbing: 0, work: 0 });
});

test("compile: a call that also runs Trail, or reads a credential file, refuses the whole skill even when that part is not a step", () => {
  assert.match(refused(compile(sheet([call("npm run build && trail skills keep release-npm")])), "never-save"), /Trail/);
  assert.match(refused(compile(sheet([call("npm run build\nnpx @trailhq/trail-code skills show x")])), "never-save"), /Trail/);
  assert.match(refused(compile(sheet([call("cat ~/.npmrc | head -2\nnpm publish")])), "never-save"), /credential/);
  // Code a heredoc writes into a file is not run; SQL fed to psql on another host is.
  const writes = "cat > internal/store/purge.go <<'EOF'\npackage store\nconst purge = \"DELETE FROM sessions WHERE expired\"\nEOF\ngo test ./internal/store/...";
  assert.deepEqual(ok(compile(sheet([call(writes)]))).steps.map((x) => x.cmd), ["go test ./internal/store/..."]);
  assert.match(refused(compile(sheet([call("echo go\npsql -h db.example.test -U app <<'EOF'\nDROP TABLE sessions;\nEOF")])), "never-save"), /SQL/);
});

test("compile: a report whose query ran as an inline script gives no skill (D51), even when another step ran", () => {
  const py = "python3 - <<'EOF'\nimport json, urllib.request\nprint(json.load(urllib.request.urlopen('https://db.example.test/rest/v1/users?select=count')))\nEOF";
  const d = refused(compile(sheet([call("git fetch -q origin prod"), call(py, { job: "report" })], { job: "report" })), "no-steps");
  assert.equal(refusalWords("no-steps", d), "the numbers came from a script written inline, not from a command Trail can keep");
  // A report whose query is a command keeps it.
  const c = compile(sheet([call('psql -h localhost -d app -c "select count(*) from users where created_at > now() - interval \'1 day\'"', { job: "report" })], { job: "report" }));
  assert.ok(c.ok, c.ok ? "" : c.detail);
});

test("compile: a step that leans on an earlier line refuses, in plain words", () => {
  const d = refused(compile(sheet([call("VER=$(npm pkg get version)\nnpm publish acme-cli-$VER.tgz")])), "multi-line");
  assert.equal(d, "uses $VER, set on an earlier line: `npm publish acme-cli-$VER.tgz`");
  assert.equal(refusalWords("multi-line", d), "a step uses $VER, set on an earlier line: `npm publish acme-cli-$VER.tgz`");
  refused(compile(sheet([call("bash <<'EOF'\nnpm run build\nnpm publish\nEOF")])), "multi-line");
  // An interpreter heredoc is a look or work (D51, D58 e): the run did nothing else, so there is no step.
  refused(compile(sheet([call("python3 - <<'EOF'\nimport subprocess\nsubprocess.run(['npm', 'publish'])\nEOF")])), "no-steps");
  refused(compile(sheet([call("python3 - <<'EOF'\nimport json\nprint(json.dumps({'a': 1}))\nEOF", { kind: "step" })])), "no-steps");
  // A cd out of the repo in the middle of the script: what follows is left out (D58 b), the build kept.
  assert.deepEqual(ok(compile(sheet([call("npm run build\ncd /srv/other\nnpm test")]))).steps.map((x) => x.cmd), ["npm run build"]);
});
