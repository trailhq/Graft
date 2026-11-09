/**
 * Reading a shell command the way the shell does: top-level segments only,
 * with quotes, substitutions, subshells, groups, loops and heredoc bodies
 * kept whole, so a `;` inside a commit message or a heredoc never becomes a
 * step. And the helpers built on it: what a command runs, what kind of call
 * it is, and whether a skill's step matches a command that ran.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  PLUMBING, RUNNERS, bareCommand, commandKind, envPrefix, isLookOnly, isMultiLine, isTrailCommand, isWork, leadingCds, normalizeCommand, onlyTrail, programOf, relativizePaths,
  simpleCommands, splitTop, stepMatches, stripLeadingSleep, stripOutputFilters, stripTimeout, stripTrailingEcho,
} from "../src/trace/shell.js";

const HEREDOC = "cat > x.sh <<'EOF' 2>&1 | tail -3\necho a; echo b | wc\nEOF";

test("shell.ts loads only its lexer and word layer, the word layer only the lexer, the lexer nothing (the PreToolUse fast path loads all three)", () => {
  const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "trace");
  const statics = (file: string) => {
    const src = readFileSync(join(dir, file), "utf8");
    assert.doesNotMatch(src, /\bimport\(/, file);
    return [...src.matchAll(/^\s*(?:import|export)\s+(?!type\b)(?:[^'";]*?\sfrom\s+)?['"]([^'"]+)['"]/gm)].map((m) => m[1]);
  };
  assert.deepEqual(statics("shell.ts"), ["./shell-scan.js", "./shell-words.js"]);
  assert.deepEqual(statics("shell-words.ts"), ["./shell-scan.js"]);
  assert.deepEqual(statics("shell-scan.ts"), []);
});

test("splitTop keeps a heredoc body with the segment whose line opened it", () => {
  assert.deepEqual(splitTop(HEREDOC), [
    { text: "cat > x.sh <<'EOF' 2>&1\necho a; echo b | wc\nEOF", sep: "|" },
    { text: "tail -3", sep: "" },
  ]);
  assert.equal(stripOutputFilters(HEREDOC), "cat > x.sh <<'EOF'\necho a; echo b | wc\nEOF");
  // Quoted and unquoted delimiters, <<- with tabs, and the line after the body.
  assert.deepEqual(splitTop("cat <<-EOF > out.txt\n\ta; b\n\tEOF\nnpm test").map((s) => s.text), ["cat <<-EOF > out.txt\n\ta; b\n\tEOF", "npm test"]);
  assert.deepEqual(splitTop('cat <<"END"\nx && y\nEND').map((s) => s.text), ['cat <<"END"\nx && y\nEND']);
  // A here-string is not a heredoc.
  assert.deepEqual(splitTop('grep x <<< "a;b"; ls').map((s) => s.text), ['grep x <<< "a;b"', "ls"]);
});

test("a heredoc inside $(...) inside quotes is opaque, apostrophes and all", () => {
  const commit = "git commit -m \"$(cat <<'EOF'\nfix: don't split; ever && never | here\n)\nEOF\n)\" && git push origin main";
  const segs = splitTop(commit);
  assert.equal(segs.length, 2);
  assert.equal(segs[0]!.sep, "&&");
  assert.equal(segs[1]!.text, "git push origin main");
  assert.equal(isMultiLine(commit), true);
});

test(";, | and && inside quotes, $(...), backticks, subshells and groups never split", () => {
  const cases: Array<[string, string[]]> = [
    ['git tag v0.22.1 -m "release; notes" && git push origin v0.22.1', ['git tag v0.22.1 -m "release; notes"', "git push origin v0.22.1"]],
    ["echo 'a|b && c'; ls", ["echo 'a|b && c'", "ls"]],
    ["printf $'a;b\\'c' | wc -c", ["printf $'a;b\\'c'", "wc -c"]],
    ["echo $(date; whoami) && ls", ["echo $(date; whoami)", "ls"]],
    ['x="$(echo "$(a; b)")" ; y', ['x="$(echo "$(a; b)")"', "y"]],
    ["echo `a; b` | wc", ["echo `a; b`", "wc"]],
    ["(sleep 8; printf '\\n'; sleep 280) | script -q /dev/null npm publish x-1.0.0.tgz", ["(sleep 8; printf '\\n'; sleep 280)", "script -q /dev/null npm publish x-1.0.0.tgz"]],
    ["{ npm run build; npm test; } && echo ok", ["{ npm run build; npm test; }", "echo ok"]],
    ["echo a\\;b; ls", ["echo a\\;b", "ls"]],
    ["echo $((1 << 2)); ls", ["echo $((1 << 2))", "ls"]],
    ["[[ -f a && -f b ]] && npm test", ["[[ -f a && -f b ]]", "npm test"]],
    ["echo ${HOME}/x; ls", ["echo ${HOME}/x", "ls"]],
    ["ls # don't care\necho ok", ["ls # don't care", "echo ok"]],
    ["echo '# not a comment'; ls", ["echo '# not a comment'", "ls"]],
  ];
  for (const [cmd, want] of cases) assert.deepEqual(splitTop(cmd).map((s) => s.text), want, cmd);
});

test("separators: &&, ||, |, ;, a newline, and a trailing &, but never a redirect's &", () => {
  assert.deepEqual(splitTop("a && b || c | d; e"), [
    { text: "a", sep: "&&" }, { text: "b", sep: "||" }, { text: "c", sep: "|" }, { text: "d", sep: ";" }, { text: "e", sep: "" },
  ]);
  assert.deepEqual(splitTop("npm run dev &"), [{ text: "npm run dev", sep: "&" }]);
  assert.deepEqual(splitTop("a & b"), [{ text: "a", sep: "&" }, { text: "b", sep: "" }]);
  assert.deepEqual(splitTop("npm test 2>&1 | tail -5"), [{ text: "npm test 2>&1", sep: "|" }, { text: "tail -5", sep: "" }]);
  assert.deepEqual(splitTop("make &> build.log"), [{ text: "make &> build.log", sep: "" }]);
  assert.deepEqual(splitTop("echo x >&2; ls"), [{ text: "echo x >&2", sep: ";" }, { text: "ls", sep: "" }]);
  assert.deepEqual(splitTop("a\nb"), [{ text: "a", sep: ";" }, { text: "b", sep: "" }]);
  assert.deepEqual(splitTop("a &&\n  b"), [{ text: "a", sep: "&&" }, { text: "b", sep: "" }]);
  assert.deepEqual(splitTop("a;"), [{ text: "a", sep: "" }]);
  assert.deepEqual(splitTop("   "), []);
});

test("a loop or an if is one segment", () => {
  assert.deepEqual(splitTop("for i in 1 2 3; do gh run list --limit 1; sleep 10; done && echo done").map((s) => s.text),
    ["for i in 1 2 3; do gh run list --limit 1; sleep 10; done", "echo done"]);
  assert.deepEqual(splitTop("if [ -f x ]; then npm test; else echo no; fi; ls").map((s) => s.text),
    ["if [ -f x ]; then npm test; else echo no; fi", "ls"]);
  assert.deepEqual(splitTop("while ! curl -s localhost:3000 >/dev/null; do\n  sleep 1\ndone\nopen http://localhost:3000").map((s) => s.text),
    ["while ! curl -s localhost:3000 >/dev/null; do\n  sleep 1\ndone", "open http://localhost:3000"]);
  // `done` and `fi` as plain words are words.
  assert.deepEqual(splitTop("echo done; echo fi").map((s) => s.text), ["echo done", "echo fi"]);
});

test("isMultiLine: any heredoc, or a newline outside quotes and bodies; a continued line is not", () => {
  assert.equal(isMultiLine("npm test"), false);
  assert.equal(isMultiLine("npm run build && \\\n  npm test"), false);
  assert.equal(isMultiLine('git commit -m "line one\nline two"'), false);
  assert.equal(isMultiLine("npm test\n"), false);
  assert.equal(isMultiLine("npm run build\nnpm test"), true);
  assert.equal(isMultiLine("x=$(\n  date\n)"), true);
  assert.equal(isMultiLine("cat <<EOF\nhi\nEOF"), true);
  assert.equal(isMultiLine(HEREDOC), true);
});

test("stripOutputFilters drops trailing tail/head/less/more/cat and the 2>&1 that fed them", () => {
  const cases: Array<[string, string]> = [
    ["npm test 2>&1 | tail -20", "npm test"],
    ["npm test 2>&1 | head -50 | tail -5", "npm test"],
    ["git log | less", "git log"],
    ["git show HEAD | more", "git show HEAD"],
    ["gh api x | cat", "gh api x"],
    ["git push origin 9c8b7a6:refs/heads/beta 2>&1 | tail -5", "git push origin 9c8b7a6:refs/heads/beta"],
    ["npm view x versions --json | jq '.[-1]'", "npm view x versions --json | jq '.[-1]'"],
    ["grep -r x src | wc -l", "grep -r x src | wc -l"],
    ["ls | sort", "ls | sort"],
    ["a | tail -5 && b", "a | tail -5 && b"],
    ["tail -f server.log", "tail -f server.log"],
    ["npm test 2>&1 | tail -20 &", "npm test &"],
  ];
  for (const [cmd, want] of cases) assert.equal(stripOutputFilters(cmd), want, cmd);
});

test("stripTrailingEcho drops a last echo or printf after &&, ; or ||", () => {
  assert.equal(stripTrailingEcho("npm test && echo done"), "npm test");
  assert.equal(stripTrailingEcho('npm test; echo "exit: $?"'), "npm test");
  assert.equal(stripTrailingEcho("npm test || echo failed"), "npm test");
  assert.equal(stripTrailingEcho("npm test && printf 'ok\\n'"), "npm test");
  assert.equal(stripTrailingEcho("echo hi"), "echo hi");
  assert.equal(stripTrailingEcho("cat x | echo y"), "cat x | echo y");
  assert.equal(stripTrailingEcho("cat > f <<'EOF'\nbody\nEOF\necho written"), "cat > f <<'EOF'\nbody\nEOF");
});

test("envPrefix splits leading assignments from the command", () => {
  assert.deepEqual(envPrefix('A=1 B="x y" npm test'), { env: ["A=1", 'B="x y"'], rest: "npm test" });
  assert.deepEqual(envPrefix("A=$(pwd) go test ./..."), { env: ["A=$(pwd)"], rest: "go test ./..." });
  assert.deepEqual(envPrefix("npm test"), { env: [], rest: "npm test" });
  assert.deepEqual(envPrefix("FOO=bar"), { env: ["FOO=bar"], rest: "" });
  assert.deepEqual(envPrefix("npm test A=1"), { env: [], rest: "npm test A=1" });
});

test("leadingCds: every leading cd, and a subshell that is the whole command", () => {
  assert.deepEqual(leadingCds("cd a && cd b; x"), { cds: ["a", "b"], rest: "x" });
  assert.deepEqual(leadingCds("(cd x && y)"), { cds: ["x"], rest: "y" });
  assert.deepEqual(leadingCds("cd backend && (cd api && go test ./...)"), { cds: ["backend", "api"], rest: "go test ./..." });
  assert.deepEqual(leadingCds('cd "/home/dev/my dir" && ls'), { cds: ["/home/dev/my dir"], rest: "ls" });
  assert.deepEqual(leadingCds("cd backend"), { cds: ["backend"], rest: "" });
  assert.deepEqual(leadingCds("cd x || exit 1"), { cds: ["x"], rest: "" });
  assert.deepEqual(leadingCds("cd x || git init"), { cds: [], rest: "cd x || git init" });
  assert.deepEqual(leadingCds("(cd x && y) && z"), { cds: [], rest: "(cd x && y) && z" });
  assert.deepEqual(leadingCds("ls && cd x"), { cds: [], rest: "ls && cd x" });
  assert.deepEqual(leadingCds("cd ~/src/shop && git status"), { cds: ["~/src/shop"], rest: "git status" });
});

test("stripLeadingSleep and stripTimeout", () => {
  assert.equal(stripLeadingSleep("sleep 30; gh run list --limit 1"), "gh run list --limit 1");
  assert.equal(stripLeadingSleep("sleep 5 && sleep 2 && npm view x version"), "npm view x version");
  assert.equal(stripLeadingSleep("(sleep 8; printf '\\n'; sleep 280) | script -q /dev/null npm publish"), "(sleep 8; printf '\\n'; sleep 280) | script -q /dev/null npm publish");
  assert.equal(stripLeadingSleep("sleep 30"), "sleep 30");
  assert.equal(stripTimeout("timeout 300 npm test"), "npm test");
  assert.equal(stripTimeout("gtimeout 60 go test ./..."), "go test ./...");
  assert.equal(stripTimeout("CI=1 timeout 120 npm test"), "CI=1 npm test");
  assert.equal(stripTimeout("timeout -s KILL 5m npm test"), "npm test");
  assert.equal(stripTimeout("npm test --timeout 300"), "npm test --timeout 300");
});

test("programOf: the first real program, two words for runners, never from quotes or a body", () => {
  const cases: Array<[string, string | null]> = [
    ["npm test", "npm test"],
    ["git push origin main", "git push"],
    ["gh pr checks 12", "gh pr"],
    ["npx vitest run", "npx vitest"],
    ["npm run build", "npm run"],
    ["A=1 B=2 go test ./...", "go test"],
    ["cd backend && go test ./...", "go test"],
    ["time npm test", "npm test"],
    ["nice -n 10 make test", "make test"],
    ["command npm publish", "npm publish"],
    ["command -v git", "command"],
    ["script -q /dev/null npm publish x.tgz", "npm publish"],
    ["(sleep 8; printf '\\n'; sleep 280) | script -q /dev/null npm login --auth-type=web", "npm login"],
    ["sleep 30; gh run list", "gh run"],
    ["timeout 60 npm test", "npm test"],
    ["timeout 5", null],
    ["nice", null],
    ["if ", null],
    ["A=1 if x", "if"],
    ["ls -la", "ls"],
    ["git -C ../shop status", "git status"],
    ["git -c core.pager=cat log", "git log"],
    ["python3 -c \"print(1)\"", "python3"],
    ["python3 -m pytest -q", "python3 pytest"],
    ['echo "a; git push"', "echo"],
    ["cat <<'EOF' > x\ngit push\nEOF", "cat"],
    ["/usr/local/bin/node scripts/build.mjs", "node build.mjs"],
    ["for i in 1 2; do gh run list; sleep 5; done", "gh run"],
    ["", null],
  ];
  for (const [cmd, want] of cases) assert.equal(programOf(cmd), want, cmd);
});

test("RUNNERS and PLUMBING", () => {
  for (const r of ["npx", "npm", "pnpm", "yarn", "go", "git", "gh", "docker", "make", "cargo", "python3"]) assert.ok(RUNNERS.has(r), r);
  assert.deepEqual([...PLUMBING].sort(), ["cd", "export", "source", ".", "echo", "printf", "sleep", "true", "false", "pwd", "clear", "set", "unset", "alias", "wait"].sort());
});

test("isLookOnly: every segment only reads or sets up the shell", () => {
  for (const c of [
    "ls -la", "cat package.json", "head -50 x", "tail -20 log", "grep -rn foo src", "rg foo", "find . -name x", "sed -n 1,20p x", "wc -l x", "pwd", "which node",
    "git status", "git log --oneline -5", "git diff", "git show HEAD", "git branch -a", "git branch --show-current", "git remote -v", "git rev-parse HEAD",
    "gh pr view 12", "gh pr list", "gh run list", "npm ls", "jq .version package.json", "cd x && ls", "git log | head -5", "cat x | jq .a",
    "command -v colima", "test -S /var/run/docker.sock", "[ -f .env ]", "sleep 30; gh run list --limit 1",
  ]) assert.equal(isLookOnly(c), true, c);
  for (const c of [
    "sed -i '' s/a/b/ x", "git rev-parse --verify main", "npm test", "git push", "git branch -D old", "git branch feat", "git remote add up x",
    "cat x > y", "ls && npm test", "curl https://x.example | jq .", "rm -f x",
  ]) assert.equal(isLookOnly(c), false, c);
});

test("isWork: the command only changes files or commits, the agent's own job", () => {
  for (const c of [
    "git add .", 'git commit -m "x"', "git add -A && git commit -m x", "git stash", "git restore src/a.ts", "git rm old.ts", "git mv a b", "git apply p.diff", "git am x.patch",
    "git checkout -- src/a.ts", "sed -i '' s/a/b/ f", "perl -pi -e s/a/b/ f", "patch -p1 < x.diff", "mkdir -p dist", "touch x", "cp a b", "mv a b", "rm x", "rm -f x",
    "chmod +x run.sh", "ln -s a b", "echo x | tee out.txt", "echo hi > x.txt", "printf 'a' >> log.txt", "cat > x.sh <<'EOF'\necho a; echo b | wc\nEOF",
    "git commit -F - <<'EOF'\nfix: the total\nEOF", HEREDOC, "git add -A && git commit -m x && git log --oneline -1",
  ]) assert.equal(isWork(c), true, c);
  for (const c of [
    "rm -rf node_modules", "rm -r dist", "git push", "echo hi > /dev/null", "echo hi", "git checkout main", "npm run build > build.log 2>&1", "npm test | tee", "ls", "git commit -m x && git push",
  ]) assert.equal(isWork(c), false, c);
});

test("isTrailCommand: trail and graft in every form they're run", () => {
  for (const c of [
    "trail skills add x --run r-1", 'graft ask "where is auth"', "npx @trailhq/trail-code skills", "npx -y @nanonets/graft@latest map",
    "node /home/dev/.npm/_npx/1/node_modules/@trailhq/trail-code/dist/bin/trail.js skills", "node dist/bin/graft.js ask x", 'cd /tmp/x && trail note "y"',
    "TRAIL_HOME=/tmp/t trail skills", "node .claude/trail-hooks.cjs stop", "trail-code skills", "npm test && trail skills on", 'bash -c "trail skills on"',
    "./node_modules/.bin/trail skills",
  ]) assert.equal(isTrailCommand(c), true, c);
  for (const c of ["npm test", "echo trail", "git log --grep trail", "ls ~/.trail", "cat trail.md", "node scripts/trail-report.js", "trailblazer run", "npx trail-mix"]) {
    assert.equal(isTrailCommand(c), false, c);
  }
});

test("normalizeCommand: filters, trailing echo, cds, sleeps and timeouts gone; quotes and extra spaces too", () => {
  assert.equal(normalizeCommand("cd backend && npm test 2>&1 | tail -20"), "npm test");
  assert.equal(normalizeCommand('sleep 5; timeout 60 npm view "@acme/x" version'), "npm view @acme/x version");
  assert.equal(normalizeCommand('git commit -m "fix  it"'), "git commit -m fix it");
  assert.equal(normalizeCommand('npm test 2>&1 | tail -5; echo "exit $?"'), "npm test");
  assert.equal(normalizeCommand("  A=1   npm   test  "), "A=1 npm test");
  assert.equal(normalizeCommand("(cd backend && go test ./...)"), "go test ./...");
});

test("stepMatches: at the start or after a top-level && or ;, params as one token, env compared unless ignored", () => {
  assert.equal(stepMatches("npm test", "npm test"), true);
  assert.equal(stepMatches("npm test", "npm test -- --grep cart"), true);
  assert.equal(stepMatches("npm test", "npm run build && npm test"), true);
  assert.equal(stepMatches("npm test", "npm run build; npm test 2>&1 | tail -5"), true);
  assert.equal(stepMatches("npm test", "npm run build | npm test"), false);
  assert.equal(stepMatches("npm test", "npm testing"), false);
  assert.equal(stepMatches("npm publish", 'echo "x && npm publish"'), false);
  const push = "git push origin {sha}:refs/heads/beta";
  assert.equal(stepMatches(push, "git push origin 9c8b7a6:refs/heads/beta 2>&1 | tail -5"), true);
  assert.equal(stepMatches(push, "git push origin 9c8b7a6:refs/heads/beta", { sha: "9c8b7a6" }), true);
  assert.equal(stepMatches(push, "git push origin 9c8b7a6:refs/heads/beta", { sha: "abc1234" }), false);
  assert.equal(stepMatches(push, "git push origin 9c8b7a6:refs/heads/prod"), false);
  assert.equal(stepMatches("git push origin beta", "git push origin beta:prod"), false);
  assert.equal(stepMatches("npm publish x-{version}.tgz", "npm publish x-1.4.3.tgz", { version: "1.4.3" }), true);
  assert.equal(stepMatches("npm publish x-{version}.tgz", "npm publish x-1x4x3.tgz", { version: "1.4.3" }), false);
  assert.equal(stepMatches("CI=1 npm test", "npm test"), false);
  assert.equal(stepMatches("CI=1 npm test", "npm test", {}, true), true);
  assert.equal(stepMatches("npm test", "CI=1 npm test"), false);
  assert.equal(stepMatches("npm test", "CI=1 npm test", {}, true), true);
  assert.equal(stepMatches("npm view @acme/x version", 'npm view "@acme/x" version'), true);
  assert.equal(stepMatches("go test ./...", "cd backend && go test ./..."), true);
  assert.equal(stepMatches("(cd backend && go test ./...)", "cd backend && go test ./..."), true);
});

test("relativizePaths: repo paths become relative, home paths $HOME, ~/ too", () => {
  const repo = "/home/dev/src/shop";
  const home = "/home/dev";
  const cases: Array<[string, string]> = [
    ["/home/dev/src/shop/scripts/release.sh 0.22.1", "./scripts/release.sh 0.22.1"],
    ["DOCKER_HOST=unix:///home/dev/.colima/default/docker.sock go test ./...", "DOCKER_HOST=unix://$HOME/.colima/default/docker.sock go test ./..."],
    ["cat ~/notes.txt", "cat $HOME/notes.txt"],
    ["cd /home/dev/src/shop && ls", "cd . && ls"],
    ["ls /home/dev2/x", "ls /home/dev2/x"],
    ["ls /home/dev/src/shopping/x", "ls $HOME/src/shopping/x"],
    ["node x.js --config=/home/dev/src/shop/x.json", "node x.js --config=./x.json"],
    ['cat "/home/dev/src/shop/a b.txt"', 'cat "./a b.txt"'],
    ["ls /opt/home/dev/x", "ls /opt/home/dev/x"],
    ["echo a~/b", "echo a~/b"],
  ];
  for (const [cmd, want] of cases) assert.equal(relativizePaths(cmd, repo, home), want, cmd);
});

test("simpleCommands opens subshells, groups and loops; bareCommand drops env and wrappers", () => {
  assert.deepEqual(simpleCommands("cd x && (npm run build; npm test) | tail -5"), ["cd x", "npm run build", "npm test", "tail -5"]);
  assert.deepEqual(simpleCommands("for i in 1 2 3; do gh run list --limit 1; sleep 10; done"), ["gh run list --limit 1", "sleep 10"]);
  assert.deepEqual(simpleCommands("if [ -f x ]; then npm test; else echo no; fi"), ["[ -f x ]", "npm test", "echo no"]);
  assert.deepEqual(simpleCommands("{ a; b; } && c"), ["a", "b", "c"]);
  assert.deepEqual(simpleCommands("cat <<'EOF' > x\ngit push\nEOF"), ["cat <<'EOF' > x"]);
  assert.equal(bareCommand("CI=1 timeout 60 npm test"), "npm test");
  assert.equal(bareCommand("time nice -n 5 go test ./..."), "go test ./...");
  assert.equal(bareCommand("script -q /dev/null npm publish x.tgz --access public"), "npm publish x.tgz --access public");
  assert.equal(bareCommand("! curl -s localhost:3000"), "curl -s localhost:3000");
});

test("commandKind: plumbing, work, look or step", () => {
  assert.equal(commandKind("cd backend"), "plumbing");
  assert.equal(commandKind("export A=1; echo $A"), "plumbing");
  assert.equal(commandKind("git add -A && git commit -m x"), "work");
  assert.equal(commandKind("git status && git diff"), "look");
  assert.equal(commandKind("for i in 1 2 3; do gh run list; sleep 10; done"), "look");
  assert.equal(commandKind("(cd backend && go test ./...)"), "step");
  assert.equal(commandKind("git commit -m x && git push"), "step");
});

test("commandKind: commands that only report on the machine, reshape text or print a version are looks", () => {
  for (const c of [
    "date", "uname -a", "ps aux", "lsof -ti:3000", "pgrep -fl node", "sort -u a.txt", "awk '{print $1}' a.txt", "cut -d, -f1 a.csv", "tr -d ' '",
    "docker ps -a", "docker --context colima ps -q", "docker logs api --tail 20", "docker inspect api", "colima status", "kubectl get pods",
    "gh api repos/acme/shop/commits/4e1c9a2/statuses --jq '.[0].state'", "gh repo view acme/shop", "gh release list --limit 3",
    "node --version", "npx --no-install vitest --version 2>/dev/null", "acme deploy --help", "open docs/design.html", "git rev-list --count HEAD",
  ]) assert.equal(commandKind(c), "look", c);
  for (const c of [
    "gh api repos/acme/shop/issues/3/labels -f labels=x", "gh api -X POST repos/acme/shop/dispatches", "open -a Docker", "npm version patch",
    "sort -o out.txt a.txt", "acme deploy --prod", "docker compose up -d",
  ]) assert.equal(commandKind(c), "step", c);
  assert.equal(commandKind("node --version > v.txt"), "work", "a look that writes a file is work");
});

// Shapes seen in real agent commands (made-up paths and scripts).
test("a runner's second word is never a heredoc opener or a redirect", () => {
  assert.equal(programOf("python3 - <<'PY'\nimport json\nprint(json.dumps({}))\nPY"), "python3");
  assert.equal(programOf("python3 <<EOF\nprint(1)\nEOF"), "python3");
  assert.equal(programOf("cd /tmp/x && node --input-type=module <<'JS'\nconsole.log(1)\nJS"), "node");
  assert.equal(programOf("python3 report.py 2>&1 | tail -5"), "python3 report.py");
  assert.equal(programOf("node >/tmp/x/out.log"), "node");
  assert.equal(programOf("npm test &>/tmp/x/test.log"), "npm test");
});

test("cd X || exit 1 is a leading cd; exit, return, trap and : only set up the shell", () => {
  assert.deepEqual(leadingCds("cd /home/dev/shop || exit 1\nnpm test"), { cds: ["/home/dev/shop"], rest: "npm test" });
  assert.deepEqual(leadingCds('cd "/home/dev/my shop" || exit\ngit log -3'), { cds: ["/home/dev/my shop"], rest: "git log -3" });
  assert.deepEqual(leadingCds("cd /home/dev/shop || return 1; cd api && go test ./..."), { cds: ["/home/dev/shop", "api"], rest: "go test ./..." });
  assert.deepEqual(leadingCds("cd /home/dev/shop || echo missing; npm test").cds, [], "only exit or return after ||");
  assert.equal(programOf("cd /home/dev/shop || exit 1\necho \"== log ==\"; git log --oneline -5"), "git log");
  assert.equal(programOf("cd /home/dev/shop || exit 1; npm run build"), "npm run");
  assert.equal(commandKind("cd /home/dev/shop || exit 1\necho \"== status ==\"; git status --short\ngit log -3"), "look");
  assert.equal(commandKind("cd /home/dev/shop || exit 1\nnpm test 2>&1 | tail -20"), "step");
  assert.equal(commandKind("exit 1"), "plumbing");
  assert.equal(commandKind("set -euo pipefail\ntrap 'rm -f /tmp/x/lock' EXIT\n: \"${PORT:=3000}\"\nls"), "look");
  assert.equal(commandKind(": > /tmp/x/out.log"), "work");
  assert.equal(normalizeCommand("cd /home/dev/shop || exit 1\nnpm test 2>&1 | tail -5"), "npm test");
  assert.ok(!PLUMBING.has("exit"), "the exported set stays the design's list");
});

test("a comment is not a program", () => {
  assert.equal(programOf("# build first\nnpm run build"), "npm run");
  assert.equal(programOf("#!/bin/bash\nset -e\nnpm test"), "npm test");
  assert.equal(programOf("gh pr view 12 # the cart fix"), "gh pr");
  assert.equal(commandKind("# what is here\nls -la /tmp/x"), "look");
  assert.equal(commandKind("# write the result > out.txt\nls"), "look", "a > in a comment writes nothing");
  assert.equal(commandKind("# nothing to run"), "plumbing");
  assert.equal(programOf("echo '#not a comment' && npm test"), "npm test");
  assert.equal(programOf("git log --format=%h#%s -3"), "git log");
});

test("a look that writes a file is work: a redirect, find -delete or -exec, git --output (the tamper check trusts a look)", () => {
  for (const c of [
    "grep x a.json > ~/.trail/settings.json", "ls > ~/.trail/x", "head -c 10 /dev/urandom > /tmp/x", "git log -1 > notes.txt", "tail -n 1 a >> ~/.trail/offers.jsonl",
    "wc -l a > b", "ls &> out.txt", "cat a >| b", "jq . a > b", "echo x 1> b",
  ]) assert.equal(commandKind(c), "work", c);
  for (const c of ["find ~/.trail -name '*.json' -delete", "find . -exec cp /tmp/fake.json {} \;", "git diff --output=/tmp/p.diff", "tree -o out.txt"]) {
    assert.equal(isLookOnly(c), false, c);
  }
  for (const c of ["grep x a 2>&1", "ls > /dev/null", "git log -1 2>/dev/null", "find . -name '*.ts'", "cat a | grep b", "ls &>/dev/null"]) assert.equal(commandKind(c), "look", c);
});

test("onlyTrail: Trail's own command and nothing else that writes or runs; isTrailCommand: Trail runs anywhere in it", () => {
  for (const c of [
    "trail skills list", "npx @trailhq/trail-code skills list", "cd /tmp/x && trail note \"use the ssh remote\"", "trail skills list | grep release",
    "TRAIL_HOME=/tmp/x trail skills list 2>&1 | tail -5", "trail skills list > /dev/null", "( cd x && trail skills list )", "bash -c 'trail skills list'",
    "trail skills list; cat ~/.trail/runs/r-1.json", "node /home/dev/acme-cli/dist/bin/trail.js skills list",
  ]) {
    assert.equal(onlyTrail(c), true, c);
    assert.equal(isTrailCommand(c), true, c);
  }
  for (const c of [
    "trail skills list; echo x > ~/.trail/runs/r.json", "trail note \"$(cp a ~/.trail/x)\"", "trail note `cp a ~/.trail/x`", "trail skills list > ~/.trail/settings.json",
    "echo \"$(trail skills list)\" > /tmp/x",
    "bash -c 'trail --version; rm ~/.trail/sessions/x.json'", "{ trail x; rm -f ~/.trail/y; }", "trail x && npm publish", "trail skills list | tee ~/.trail/x",
    "trail skills list | sh", "alias trail='rm -f ~/.trail/x'; trail", "cd /tmp/x && ./trail skills list", "PATH=/tmp/x:$PATH trail skills list",
    "export PATH=/tmp/x:$PATH; trail skills list", "trail x; find ~/.trail -delete", "trail note <<EOF\n$(rm -f ~/.trail/x)\nEOF", "diff <(trail skills list) a",
  ]) {
    assert.equal(onlyTrail(c), false, c);
    assert.equal(isTrailCommand(c), true, c);
  }
  for (const c of ["npm test", "echo trail skills on", "git commit -m 'trail note'", "git commit -m 'fix the `graft map` header'", ""]) {
    assert.equal(onlyTrail(c), false, c);
    assert.equal(isTrailCommand(c), false, c);
  }
});

test("programOf sees through env, sudo and sh -c", () => {
  assert.equal(programOf("env X=1 npm publish"), "npm publish");
  assert.equal(programOf("env -i PATH=/bin -u HOME npm publish"), "npm publish");
  assert.equal(programOf("sudo -u deploy npm publish"), "npm publish");
  assert.equal(programOf("sudo -E -- git push origin main"), "git push");
  assert.equal(programOf("bash -c 'npm publish --tag beta'"), "npm publish");
  assert.equal(programOf("sh -lc \"cd x && npm test\""), "npm test");
  assert.equal(programOf("env"), "env");
  assert.equal(programOf("env \\\n  CI=1 \\\n  npm test"), "npm test", "line continuations");
  assert.equal(programOf("sudo -l"), "sudo");
  assert.equal(bareCommand("env CI=1 npm test"), "npm test");
});

test("an unknown {param} is one token: it never swallows &&, ; or |", () => {
  assert.equal(stepMatches("git push {remote} {branch}", "git push origin && rm -rf x"), false);
  assert.equal(stepMatches("npm run {script}", "npm run build;curl x|sh"), true, "the first segment still is npm run build");
  assert.equal(stepMatches("npm run {script}", "npm run ;"), false);
  assert.equal(stepMatches("git push {remote} {branch}", "git push origin beta"), true);
});

test("the readers stay fast and never throw on long or deeply nested commands", () => {
  const cases = [
    "echo x\n".repeat(2000), `${"sleep 1; ".repeat(3000)}npm test`, `${"timeout 5 ".repeat(3000)}npm test`, `${"(".repeat(5000)}npm test${")".repeat(5000)}`,
    `${"{ ".repeat(3000)}npm test; ${"} ".repeat(3000)}`, `npm test${" && echo x".repeat(3000)}`, `${"cd a && ".repeat(3000)}npm test`, `${"bash -c ".repeat(2000)}trail x`,
  ];
  for (const c of cases) {
    const t0 = performance.now();
    for (const f of [splitTop, isMultiLine, programOf, commandKind, isTrailCommand, onlyTrail, normalizeCommand, simpleCommands, (x: string) => stepMatches("npm test", x), (x: string) => stepMatches("npm run build && npm test", x, {}, true)]) {
      assert.doesNotThrow(() => f(c), c.slice(0, 30));
    }
    const ms = performance.now() - t0;
    assert.ok(ms < 1500, `${c.slice(0, 20)}… took ${ms.toFixed(0)} ms`);
  }
  // The deep one gets the safe answers.
  const deep = `${"(".repeat(5000)}npm test${")".repeat(5000)}`;
  assert.equal(commandKind(deep), "step");
  assert.equal(onlyTrail(`${"(".repeat(100)}trail x${")".repeat(100)}`), false);
});

test("<<- strips leading tabs only: a terminator indented with spaces does not end the body", () => {
  assert.deepEqual(splitTop("cat <<-EOF\n\tbody\n\tEOF\nnpm publish").map((s) => s.text), ["cat <<-EOF\n\tbody\n\tEOF", "npm publish"]);
  assert.deepEqual(splitTop("cat <<-EOF\n  body\n  EOF\nnpm publish").map((s) => s.text), ["cat <<-EOF\n  body\n  EOF\nnpm publish"]);
  assert.deepEqual(splitTop("cat <<EOF\n\tEOF\nEOF\nls").map((s) => s.text), ["cat <<EOF\n\tEOF\nEOF", "ls"], "plain << strips nothing");
});

test("commandKind: listing worktrees, stashes and tags is a look; making them is not (g2 review)", () => {
  for (const cmd of ["git worktree list", "git stash list", "git stash show -p", "git tag", "git tag -l 'v0.*'", "git tag --contains HEAD"]) assert.equal(commandKind(cmd), "look", cmd);
  for (const cmd of ["git worktree add ../x", "git stash", "git tag v1.0.0", "git tag -a v1.0.0 -m x"]) assert.notEqual(commandKind(cmd), "look", cmd);
});

test("commandKind (D51, D58 e): an inline or heredoc script is a look or work; only one line that starts a program is a step", async () => {
  const { foldKind } = await import("../src/trace/run-calls.js");
  const table: Array<[string, string]> = [
    [`node -e "require('./scripts/release.js')"`, "step"],
    [`python3 -c "import subprocess; subprocess.run(['make'])"`, "step"],
    [`node -e '\nrequire("./scripts/release.js")\n'`, "work"],
    [`node -e "const {execSync}=require('child_process');\nexecSync('make dist')"`, "work"],
    [`node -e "console.log(require('./package.json').version)"`, "look"],
    ["node -e 'console.log(`v${process.version}`)'", "look"],
    [`python3 -c "import json,sys; print(json.load(sys.stdin)['v'])"`, "look"],
    [`python3 -c "import json,sys; print(json.load(sys.stdin)['v'])" > out.json`, "work"],
    [`python3 -c "open('a.txt','w').write('x')"`, "work"],
    [`python3 -W ignore -c "print(1)"`, "look"],
    [`python3 -c "import requests; print(requests.get('https://api.example.test/x').json())"`, "look"],
    [`python3 -c "import requests; requests.post('https://api.example.test/x', json={})"`, "work"],
    ["perl -ne 'print if /x/' a.txt", "look"],
    ["perl -pi -e 's/a/b/' x.txt", "work"],
    ["node -r ts-node/register scripts/x.ts", "step"],
    ["node scripts/x.mjs", "step"],
    ["python3 - <<'EOF'\nimport subprocess\nsubprocess.run(['make'])\nEOF", "work"],
    ["python3 - <<'EOF'\nimport json\nprint(json.load(open('package.json'))['version'])\nEOF", "look"],
    ["python3 scripts/load.py <<'EOF'\nrow1\nEOF", "step"],
    // `-` is the program from stdin; the words after it are the script's own arguments.
    ["python3 -I - \"$f\" out.json <<'EOF'\nimport json,sys\nprint(json.load(open(sys.argv[1])))\nEOF", "look"],
    ["python3 - data.json <<'EOF'\nimport sys\nopen(sys.argv[1], 'w').write('{}')\nEOF", "work"],
    ["bash <<'EOF'\nmake dist\nEOF", "step"],
  ];
  for (const [cmd, kind] of table) {
    assert.equal(commandKind(cmd), kind, cmd);
    // The fold reads the same (run-calls.ts `foldKind`), so the run verdict and compile agree.
    assert.equal(foldKind(cmd, null), kind, `fold: ${cmd}`);
  }
});
