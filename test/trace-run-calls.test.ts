/**
 * The fold's calls (design 4.1): the folder each command really ran in, what
 * kind of call it is, secrets named or refused, outcomes PostToolUse saw
 * first, host refusals (never ran), and the tamper rules that stop a session
 * from saving after the agent wrote Trail's or the host's files.
 */
import { test } from "node:test";
import { resolve, sep } from "node:path";
import assert from "node:assert/strict";
import { foldKind, hostRefused, interpreterKind, runHelpers } from "../src/trace/run-calls.js";
import { toolResult, toolUse } from "./trace-fixtures.js";
import { ask, at, bash, emptyState, runCall, session } from "./trace-run-fixtures.js";

const calls = (s: ReturnType<typeof session>) => s.st.runs.flatMap((r) => r.calls);

test("the folder follows the entry cwd across calls: a bare cd is plumbing, the next call lands in that folder", () => {
  const s = session("folder");
  s.fold([
    ask("run the integration tests", 0),
    ...bash("cd backend", "", { sec: 1 }),
    ...bash("go test ./...", "ok  acme/shop/backend 0.3s", { sec: 3, cwd: "/home/dev/shop/backend" }),
  ]);
  const [cd, test1] = calls(s);
  assert.equal(cd!.kind, "plumbing");
  assert.deepEqual([test1!.key, test1!.cwd, test1!.kind], ["github.com/acme/shop", "backend", "step"]);
});

test("cd chains, a cd subshell, ~ and $HOME are followed; a folder only the shell knows is none", () => {
  const s = session("cds");
  const before = process.env.HOME;
  const beforeProfile = process.env.USERPROFILE;
  process.env.HOME = "/home/dev"; // os.homedir() follows $HOME
  process.env.USERPROFILE = "/home/dev"; // and on Windows, %USERPROFILE%
  try {
    s.fold([
      ask("run the integration tests", 0),
      ...bash("cd backend && cd internal; go vet ./...", "", { sec: 1 }),
      ...bash("(cd web && npm run build)", "", { sec: 2 }),
      ...bash("cd ~/storefront && make", "", { sec: 3 }),
      ...bash("cd $HOME/storefront/api && make", "", { sec: 4 }),
      ...bash('cd "$WORK" && make', "", { sec: 5 }),
      ...bash("cd /opt/elsewhere && make", "", { sec: 6 }),
    ]);
  } finally {
    process.env.HOME = before;
    if (beforeProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = beforeProfile;
  }
  const got = calls(s).map((c) => [c.key, c.cwd]);
  assert.deepEqual(got, [
    ["github.com/acme/shop", "backend/internal"],
    ["github.com/acme/shop", "web"],
    ["github.com/acme/storefront", ""],
    ["github.com/acme/storefront", "api"],
    [null, null],
    [null, null],
  ]);
});

test("a run's repo is where most of its step calls ran: a session in a parent folder puts a release in the child's repo", () => {
  const s = session("parent");
  s.fold([
    ask("publish 1.4.3", 0, { cwd: "/home/dev" }),
    ...bash("cd storefront && npm run build", "", { sec: 1, cwd: "/home/dev" }),
    ...bash("npm publish", "+ acme-cli@1.4.3", { sec: 2, cwd: "/home/dev/storefront" }),
    ...bash("ls", "", { sec: 3, cwd: "/home/dev/shop" }),
  ], { checkout: "", repoKey: "local/home/dev" });
  assert.equal(s.st.runs[0]!.repoKey, "github.com/acme/storefront");
  const t = session("parent2");
  t.fold([ask("hello there", 0), ...bash("ls", "", { sec: 1 })], { checkout: "", repoKey: "local/home/dev" });
  assert.equal(t.st.runs[0]!.repoKey, "local/home/dev", "no step calls: the session's key");
});

test("kinds: plumbing, work, look, step; read-only checks are look, test runs are steps", () => {
  const table: Array<[string, string]> = [
    ["cd backend", "plumbing"],
    ["export A=1", "plumbing"],
    ["cat > x.sh <<'EOF' 2>&1 | tail -3\necho a; echo b | wc\nEOF", "work"],
    ["git commit -F - <<'EOF'\nfix: cart total\nEOF", "work"],
    ["git status && git diff", "look"],
    ["gh api repos/acme/shop/commits/4e1c9a2/status --jq .state", "look"],
    ["npm view acme-cli version", "look"],
    ["npm test", "step"],
    ["git push origin main:beta", "step"],
    ["sleep 30; gh run list --limit 1", "look"],
  ];
  for (const [cmd, kind] of table) assert.equal(foldKind(cmd, null), kind, cmd);
});

test("interpreter heredocs (D51, D58 e): writing files, running programs or sending is work, reading or printing is look", () => {
  const table: Array<[string, string]> = [
    ["python3 - <<'EOF'\nimport json\nopen('out.json', 'w').write(json.dumps({}))\nEOF", "work"],
    ["python3 <<'EOF'\nfrom pathlib import Path\nPath('a.txt').write_text('x')\nEOF", "work"],
    ["node --input-type=module <<'EOF'\nimport { writeFileSync } from 'node:fs';\nwriteFileSync('a', 'b');\nEOF", "work"],
    ["python3 - <<'EOF'\nimport json\nprint(json.load(open('package.json'))['version'])\nEOF", "look"],
    ["cd backend && python3 - <<'EOF'\nprint(1)\nEOF", "look"],
    ["python3 - <<'EOF'\nimport subprocess\nsubprocess.run(['git', 'push'])\nEOF", "work"],
    ["node <<'EOF'\nconst r = await fetch('https://api.example.com/x');\nEOF", "look"],
    ["node <<'EOF'\nawait fetch('https://api.example.com/x', { method: 'POST', body: '{}' });\nEOF", "work"],
    ["python3 scripts/load.py <<'EOF'\nrow1\nEOF", "step"],
    ["python3 - <<'EOF' && npm test\nprint(1)\nEOF", "step"],
  ];
  for (const [cmd, kind] of table) assert.equal(foldKind(cmd, null), kind, cmd);
  assert.equal(interpreterKind("print('hi')"), "look");
});

test("a call keeps its redacted command, background flag, size and line marks", () => {
  const s = session("call");
  const long = `curl -s https://api.example.com/x -d '${"y".repeat(2100)}'`;
  s.fold([
    ask("run the integration tests", 0),
    ...bash("NPM_TOKEN=npm_aB3dE5gH7jK9mN1pQ3rS5tU7vW9xY1zA2bC4 npm publish", "+ acme-cli@1.4.3", { sec: 1 }),
    ...bash('curl -H "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U" https://api.example.com/x', "{}", { sec: 2 }),
    ...bash("npm run dev &", "", { sec: 3 }),
    ...bash("npm run dev", "", { sec: 4, bg: true }),
    ...bash(long, "", { sec: 5 }),
    ...bash("git commit -F - <<'EOF'\nmsg\nEOF", "", { sec: 6 }),
  ]);
  const [named, refused, amp, bgFlag, big, multi] = calls(s);
  assert.equal(named!.cmd, "NPM_TOKEN=${NPM_TOKEN:?set NPM_TOKEN} npm publish");
  assert.equal(named!.secret, "named");
  assert.equal(refused!.cmd, null);
  assert.equal(refused!.secret, "refused");
  assert.equal(amp!.bg, true);
  assert.equal(bgFlag!.bg, true);
  assert.equal(big!.truncated, true);
  assert.deepEqual([big!.cmd, big!.secret, big!.parts], [null, undefined, [{ cmd: null, sep: "", kind: "work", long: true }]],
    "a command too long to keep whole is kept piece by piece, a piece over 2,000 characters as a work marker (D58c)");
  assert.equal(multi!.multiLine, true);
  assert.ok(!JSON.stringify(s.st).includes("npm_aB3dE5"), "no secret reaches the state");
  assert.ok(!JSON.stringify(s.st).includes("eyJhbGci"));
});

test("a result: failed from the host flag or the text, its error line, its offset, its check and tail", () => {
  const s = session("result");
  s.fold([
    ask("publish 1.4.3", 0),
    ...bash("npm publish acme-cli-1.4.3.tgz", "npm error code E401\nnpm error Unable to authenticate", { sec: 1, isError: true }),
    ...bash("npm publish acme-cli-1.4.3.tgz", "npm notice Publishing\n+ acme-cli@1.4.3", { sec: 5 }),
    ...bash("npm view acme-cli version", "1.4.3", { sec: 8 }),
    ...bash("ls dist", "a.js", { sec: 9 }),
  ]);
  const run = s.st.runs[0]!;
  const [bad, good, view, ls] = run.calls;
  assert.deepEqual([bad!.failed, bad!.isError, bad!.errorLine], [true, true, "npm error code E401"]);
  assert.ok((bad!.src.result ?? 0) > bad!.src.use && bad!.src.use > 0);
  assert.equal(good!.tail, "npm notice Publishing\n+ acme-cli@1.4.3");
  assert.deepEqual(view!.check, { family: "npm-view", passed: true, facts: { version: "1.4.3", pkg: "acme-cli" } });
  assert.equal(view!.tail, "1.4.3");
  assert.equal(ls!.tail, undefined, "only checks, polls, rev-parse, pushes and publishes keep a tail");
  assert.equal(run.failedCount, 1);
  assert.equal(run.commands, 4);
});

test("a poll keeps its tail: the same command again, with only look calls between", () => {
  const s = session("poll");
  s.fold([
    ask("push to beta", 0),
    ...bash("./scripts/wait-ready.sh", "pending", { sec: 1 }),
    ...bash("sleep 20", "", { sec: 2 }),
    ...bash("./scripts/wait-ready.sh", "ready", { sec: 25 }),
  ]);
  assert.equal(s.st.runs[0]!.calls[2]!.tail, "ready");
});

test("the host refused to run a call (D51): never ran, so not a command, not a failure", () => {
  for (const text of [
    "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file).",
    "Permission for this action was denied by the auto mode classifier. Reason: Blocked by classifier.",
    "Permission for this command was denied by a built-in safety check, not by the user.",
    "model-x is temporarily unavailable, so auto mode cannot determine the safety of Bash right now.",
    "<tool_use_error>Blocked: sleep 45 followed by: cat out.txt. To wait for a condition, use Monitor.</tool_use_error>",
    "PreToolUse:Bash hook error: [.claude/hooks/block.sh]: BLOCKED: rm with recursive+force",
    "This session is isolated in the worktree /home/dev/wt but this command names git in a form too complex to verify. Refusing to run it.",
    "rm in '/tmp/x/a.md' was blocked. For security, only files in the allowed working directories can be removed.",
  ]) assert.equal(hostRefused(text), true, text);
  assert.equal(hostRefused("Exit code 1\nnpm error code E401"), false);
  const s = session("refused");
  s.fold([
    ask("push to beta", 0),
    ...bash("git push origin main:beta", "The user doesn't want to proceed with this tool use. The tool use was rejected.", { sec: 1, isError: true }),
    ...bash("git push origin main:beta", "ok", { sec: 5 }),
  ]);
  const run = s.st.runs[0]!;
  assert.deepEqual([run.commands, run.failedCount, run.stepCalls, run.toolCalls, run.calls.length], [1, 0, 1, 1, 1]);
});

test("marks fill a call the transcript has no result for yet; the transcript's result replaces the mark", () => {
  const s = session("marks");
  s.fold([ask("publish 1.4.3", 0), ...bash("npm publish acme-cli-1.4.3.tgz", "+ acme-cli@1.4.3", { sec: 1 }), toolUse("toolu_v", "Bash", { command: "npm view acme-cli version" }, { timestamp: at(5) })],
    { marks: [{ id: "toolu_v", at: at(6), failed: false, tail: "1.4.3" }, { id: "toolu_gone", at: at(6), failed: true }] });
  let view = s.st.runs[0]!.calls[1]!;
  assert.equal(view.fromMark, true);
  assert.equal(view.check?.passed, true);
  assert.equal(view.src.result, null);
  s.fold([toolResult("toolu_v", "npm error code E404", true, { timestamp: at(7) })]);
  view = s.st.runs[0]!.calls[1]!;
  assert.equal(view.fromMark, undefined);
  assert.equal(view.failed, true);
  assert.equal(view.check?.passed, false);
  assert.equal(s.st.runs[0]!.failedCount, 1);
  // A failed mark counted once, and undone when the transcript says it worked.
  const t = session("marks2");
  t.fold([ask("run the integration tests", 0), toolUse("toolu_t", "Bash", { command: "npm test" }, { timestamp: at(1) })], { marks: [{ id: "toolu_t", at: at(2), failed: true }] });
  assert.equal(t.st.runs[0]!.failedCount, 1);
  t.fold([], { marks: [{ id: "toolu_t", at: at(2), failed: true }] });
  assert.equal(t.st.runs[0]!.failedCount, 1, "a mark already applied is not applied twice");
  t.fold([toolResult("toolu_t", "Test Files  1 passed (1)", false, { timestamp: at(3) })]);
  assert.equal(t.st.runs[0]!.failedCount, 0);
  assert.equal(t.st.runs[0]!.calls[0]!.check?.passed, true);
});

test("Trail's own commands are ignored entirely; its hook scripts run by hand mark the session", () => {
  const s = session("trail");
  s.fold([
    ask("publish 1.4.3", 0),
    ...bash("trail skills add release-npm --run r-1001-aaaa", "saved", { sec: 1 }),
    ...bash("npx @trailhq/trail-code skills draft r-1001-aaaa --print", "...", { sec: 2 }),
    toolUse("toolu_m", "mcp__trail__find_code", { q: "x" }, { timestamp: at(3) }),
    ...bash("npm publish", "+ acme-cli@1.4.3", { sec: 4 }),
  ]);
  const run = s.st.runs[0]!;
  assert.deepEqual([run.commands, run.toolCalls, run.calls.length], [1, 1, 1]);
  assert.equal(s.st.tampered, null);
  s.fold([...bash("node /home/dev/.trail/bin/trail-hooks.cjs stop < payload.json", "", { sec: 10 })]);
  assert.equal(s.st.tampered, "Bash trail-hooks.cjs");
});

test("a command that runs Trail and anything else is not Trail's own: it is counted, and the tamper check sees it", () => {
  const s = session("trail-mixed");
  s.fold([
    ask("publish 1.4.3", 0),
    ...bash("trail skills list && npm publish", "+ acme-cli@1.4.3", { sec: 1 }),
  ]);
  const run = s.st.runs[0]!;
  assert.deepEqual([run.commands, run.calls.length, run.stepCalls], [1, 1, 1]);
  assert.equal(s.st.tampered, null);
  s.fold([...bash("trail skills list; echo x >> /home/dev/.trail/offers.jsonl", "", { sec: 2 })], { trailHome: "/home/dev/.trail" });
  assert.equal(run.commands, 2);
  assert.ok(s.st.tampered, "writing Trail's files after a Trail command still marks the session");
});

test("tamper rules: writing Trail's files or the transcript marks the session for good; reading them does not", () => {
  const ctx = { trailHome: "/home/dev/.trail" };
  const read = session("tamper-read");
  read.fold([ask("check the runs", 0), ...bash("cat ~/.trail/runs/r-1001-aaaa.json && ls $HOME/.trail", "{}", { sec: 1 })], ctx);
  assert.equal(read.st.tampered, null);

  const write = session("tamper-write");
  write.fold([ask("fix it", 0), toolUse("toolu_w", "Write", { file_path: "/home/dev/.trail/runs/r-1001-aaaa.json", content: "{}" }, { timestamp: at(1) })], ctx);
  assert.equal(write.st.tampered, `Write ${resolve("/home/dev/.trail/runs/r-1001-aaaa.json")}`);
  write.fold([...bash("echo x >> ~/.trail/offers.jsonl", "", { sec: 2 })], ctx);
  assert.equal(write.st.tampered, `Write ${resolve("/home/dev/.trail/runs/r-1001-aaaa.json")}`, "the first one stays");

  const tx = session("tamper-tx");
  tx.fold([ask("fix it", 0), ...bash(`echo '{"type":"user"}' >> ${"PATH_PLACEHOLDER"}`, "", { sec: 1 })], ctx);
  assert.equal(tx.st.tampered, null, "a different file");
  // A shell word's '\' is an escape: on Windows the agent writes the transcript's path with '/'.
  tx.fold([...bash(`echo '{"type":"user"}' >> ${tx.path.split(sep).join("/")}`, "", { sec: 2 })], ctx);
  assert.equal(tx.st.tampered, "Bash echo");

  const proj = session("tamper-proj");
  proj.fold([ask("fix it", 0), ...bash("sed -i '' 's/a/b/' ~/.claude/projects/x/s.jsonl", "", { sec: 1 })], ctx);
  assert.equal(proj.st.tampered, "Bash sed");

  const env = session("tamper-env");
  env.fold([ask("fix it", 0), ...bash('rm "$TRAIL_HOME/state/skills.json"', "", { sec: 1 })], ctx);
  assert.equal(env.st.tampered, "Bash rm");
});

test("at most 200 calls per run, oldest dropped; the count stays true", () => {
  const s = session("cap");
  const entries: object[] = [ask("run the integration tests", 0)];
  for (let i = 0; i < 205; i++) entries.push(...bash(`npm test -- shard-${i}`, "ok", { sec: i + 1 }));
  s.fold(entries);
  const run = s.st.runs[0]!;
  assert.equal(run.calls.length, 200);
  assert.equal(run.commands, 205);
  assert.equal(run.calls[0]!.cmd, "npm test -- shard-5");
});

test("helpers: scripts a run executed from scratch folders, by absolute path", () => {
  const run = {
    calls: [
      runCall({ cmd: "node /private/tmp/claude-501/x/scratchpad/npm-pty.mjs publish" }),
      runCall({ cmd: "bash /tmp/release.sh 1.4.3" }),
      runCall({ cmd: "/home/dev/shop/scripts/release.sh" }),
      runCall({ cmd: "node /tmp/failed.mjs", failed: true }),
      runCall({ cmd: "cat /tmp/notes.txt", kind: "look" }),
    ],
  };
  assert.deepEqual(runHelpers(run), ["/private/tmp/claude-501/x/scratchpad/npm-pty.mjs", "/tmp/release.sh"]);
  assert.deepEqual(emptyState().runs, []);
});
