/**
 * Trying to break the fold and the gate (the g3 review): background commands,
 * parallel calls, notices mid-run, subagent lines, writes to Trail's files by
 * every route a shell offers (a symlink included), each entrypoint, two hook
 * processes at once, and the modes of every file the skills code writes.
 * Synthetic repos, prompts and output only.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkedSuccess, freshRunId } from "../src/trace/runs.js";
import { effectiveFolder } from "../src/trace/run-calls.js";
import { tamperOf } from "../src/trace/tamper.js";
import { appendPostMark, gateFilePath, writeGateFile } from "../src/trace/gate-file.js";
import { notePoolDay, poolPath } from "../src/trace/pool.js";
import { skillsGate, withSkillSession } from "../src/trace/skill-session.js";
import { jsonl, said, sidechain, taskNotification, toolResult, toolUse } from "./trace-fixtures.js";
import { ask, at, bash, injection, session } from "./trace-run-fixtures.js";

const POSIX = process.platform !== "win32";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "src");

/* ------------------------------------------------------ background commands */

test("a background command's result is not its outcome: it never passes a check", () => {
  const s = session("bg");
  s.fold([
    ask("run the tests", 0),
    ...bash("npm test", "Command running in background with ID: b1x2. Output is being written to: /tmp/tasks/b1x2.output", { sec: 1, bg: true }),
    ...bash("npm run test:e2e &", "", { sec: 2 }),
  ]);
  const run = s.st.runs[0]!;
  assert.deepEqual(run.calls.map((c) => [c.bg, c.check?.passed ?? null]), [[true, false], [true, false]]);
  assert.equal(checkedSuccess(run, "Started the tests.").checked, false);
});

/* ---------------------------------------------- parallel calls, notices, subagents */

test("parallel calls in one turn, results arriving in the other order, each get their own outcome", () => {
  const s = session("parallel");
  const turn = said("Running both.", { timestamp: at(1) }) as { message: { content: unknown[] } };
  turn.message.content.push(
    { type: "tool_use", id: "toolu_par_a", name: "Bash", input: { command: "npm run lint" } },
    { type: "tool_use", id: "toolu_par_b", name: "Bash", input: { command: "npm run build" } },
  );
  s.fold([ask("run the tests", 0), turn, toolResult("toolu_par_b", "error TS2304: Cannot find name 'x'.", true, { timestamp: at(3) }), toolResult("toolu_par_a", "ok", false, { timestamp: at(4) })]);
  const run = s.st.runs[0]!;
  assert.deepEqual(run.calls.map((c) => [c.cmd, c.failed]), [["npm run lint", false], ["npm run build", true]]);
  assert.equal(run.failedCount, 1);
});

test("a task notice mid-run starts nothing; a subagent's lines in the parent transcript are not the run's", () => {
  const s = session("notice");
  s.fold([
    ask("run the integration tests", 0),
    ...bash("npm run db:up", "ok", { sec: 1 }),
    taskNotification(),
    sidechain(),
    toolUse("toolu_side", "Bash", { command: "rm -rf build" }, { isSidechain: true, timestamp: at(3) }),
    toolResult("toolu_side", "", false, { isSidechain: true, timestamp: at(4) }),
    ...bash("npm run test:integration", "Tests  9 passed (9)", { sec: 5 }),
  ]);
  assert.equal(s.st.runs.length, 1);
  assert.deepEqual([s.st.runs[0]!.typedCount, s.st.runs[0]!.commands, s.st.runs[0]!.toolCalls], [1, 2, 2]);
});

/* ------------------------------------------------------------------ cd chains */

test("cd chains: `cd -` back to where the call started is known; one with no cd before it in the call is not", () => {
  assert.equal(effectiveFolder("/home/dev/shop", "cd backend && cd - && npm test", "/home/dev"), "/home/dev/shop");
  assert.equal(effectiveFolder("/home/dev/shop", "cd backend && cd ../web && cd - && go test ./...", "/home/dev"), resolve("/home/dev/shop/backend"));
  assert.equal(effectiveFolder("/home/dev/shop", "cd - && npm test", "/home/dev"), null);
});

/* --------------------------------------------------------------------- tamper */

function homeWithTrail(): { home: string; trail: string; ctx: { trailHome: string; transcriptPath: string; home: string } } {
  const home = mkdtempSync(join(tmpdir(), "breaks-home-"));
  const trail = join(home, ".trail");
  mkdirSync(join(trail, "runs"), { recursive: true });
  writeFileSync(join(trail, "settings.json"), "{}");
  const transcript = join(home, ".claude", "projects", "-home-dev-shop", "5f0c.jsonl");
  mkdirSync(join(transcript, ".."), { recursive: true });
  writeFileSync(transcript, "");
  return { home, trail, ctx: { trailHome: trail, transcriptPath: transcript, home } };
}

test("tamper: every shell route to a write trips it (pushd, cd -, tar, unzip, >|, awk inplace, a variable, ln)", () => {
  const { ctx } = homeWithTrail();
  const bashT = (cmd: string) => tamperOf("Bash", { command: cmd }, cmd, { ...ctx, folder: "/home/dev/shop" });
  for (const cmd of [
    "pushd ~/.trail && rm settings.json",
    "cd ~/.trail && cd /tmp && cd - && rm settings.json",
    "tar -xf /tmp/forged.tar -C ~/.trail",
    "tar --directory=$HOME/.trail -xzf /tmp/forged.tgz",
    "unzip -o /tmp/forged.zip -d ~/.trail/skills",
    "echo '{}' >| ~/.trail/settings.json",
    "awk -i inplace '{print}' ~/.trail/state/skills.json",
    "D=~/.trail; echo x > $D/settings.json",
    'export T="$HOME/.trail" && echo x > "$T/offers.jsonl"',
    "ln -s ~/.trail/settings.json /tmp/alias.json",
    `ln -sf /tmp/forged.jsonl ${ctx.transcriptPath}`,
    `python3 -c "open('$HOME/.trail/settings.json','w').write('{}')"`,
    `node -e 'require("fs").writeFileSync(require("os").homedir()+"/.trail/settings.json","{}")'`,
    `sed -i '' 's/no/yes/' ${ctx.transcriptPath}`,
  ]) assert.ok(bashT(cmd), cmd);
  for (const cmd of ["cat ~/.trail/settings.json", "D=~/.trail; ls $D", "ln -s /home/dev/shop/dist /tmp/dist", "tar -czf /tmp/backup.tgz -C ~/.trail .", "echo x >| /tmp/out.txt"]) {
    assert.equal(bashT(cmd), null, cmd);
  }
});

test("tamper: a write through a symlink that leads into Trail's home trips it, and so does a Trail home that is itself a link", { skip: !POSIX && "posix only" }, () => {
  const { home, trail, ctx } = homeWithTrail();
  const alias = join(home, "alias.json");
  symlinkSync(join(trail, "settings.json"), alias);
  const dirAlias = join(home, "notes");
  symlinkSync(join(trail, "runs"), dirAlias);
  const at = (cmd: string, c = ctx) => tamperOf("Bash", { command: cmd }, cmd, { ...c, folder: home });
  assert.ok(at(`echo '{"skills":"on"}' > ${alias}`));
  assert.ok(at(`cp /tmp/forged.json ${dirAlias}/r-1001-aaaa.json`), "a new file in a linked folder");
  assert.equal(at(`cat ${alias}`), null);
  assert.ok(tamperOf("Write", { file_path: alias }, null, ctx), "an edit tool through the link");
  // ~/.trail is a link to a folder elsewhere: writing the real folder is writing Trail's home.
  const real = join(home, "data", "trail");
  mkdirSync(real, { recursive: true });
  const linkedHome = join(home, "linked-trail");
  symlinkSync(real, linkedHome);
  assert.ok(at(`echo x > ${join(real, "settings.json")}`, { ...ctx, trailHome: linkedHome }));
});

/* ------------------------------------------------------------------- the gate */

test("the gate: a bare `sdk` entrypoint is a script too, as the transcript reader already treats it", () => {
  const home = mkdtempSync(join(tmpdir(), "breaks-gate-"));
  mkdirSync(join(home, ".trail"), { recursive: true });
  writeFileSync(join(home, ".trail", "settings.json"), JSON.stringify({ skills: "on" }));
  const env = { HOME: home, TRAIL_HOME: join(home, ".trail"), CLAUDE_CODE_ENTRYPOINT: "sdk", PATH: process.env.PATH };
  const g = skillsGate({ session_id: "s-1", cwd: ROOT, transcript_path: "/x.jsonl" }, ROOT, env);
  assert.ok(g.ok);
  assert.deepEqual([g.ctx.entry, g.ctx.fold, g.ctx.learnOff], ["headless", false, "headless"]);
});

/* ---------------------------------------------------- files: links, ids, modes */

test("a post mark is never written through a symlink", { skip: !POSIX && "posix only" }, () => {
  const home = mkdtempSync(join(tmpdir(), "breaks-mark-"));
  const env = { TRAIL_HOME: join(home, ".trail") };
  mkdirSync(join(home, ".trail", "sessions"), { recursive: true });
  const victim = join(home, "victim.txt");
  writeFileSync(victim, "keep\n", { mode: 0o644 });
  symlinkSync(victim, join(home, ".trail", "sessions", "s-link.post.jsonl"));
  assert.throws(() => appendPostMark("s-link", { id: "toolu_1", at: at(1), failed: false }, env));
  assert.equal(readFileSync(victim, "utf8"), "keep\n");
  assert.equal(statSync(victim).mode & 0o777, 0o644);
});

test("a new run's id is never one already taken in this session or by a sheet on disk", () => {
  let asked = 0;
  const id = freshRunId(new Date(2026, 9, 27, 10), () => ++asked < 4);
  assert.match(id, /^r-1027-[0-9a-f]{4}$/);
  assert.equal(asked, 4, "it kept drawing until an id was free");
  const s = session("ids");
  const sheets = join(mkdtempSync(join(tmpdir(), "breaks-ids-")), ".trail");
  mkdirSync(join(sheets, "runs"), { recursive: true });
  s.fold([ask("run the tests", 0), ...bash("npm test", "ok", { sec: 1 })], { trailHome: sheets });
  assert.ok(!existsSync(join(sheets, "runs", `${s.st.runs[0]!.id}.json`)));
});

test("modes: every skills file is 0600 in 0700 folders", { skip: !POSIX && "posix only" }, () => {
  const home = mkdtempSync(join(tmpdir(), "breaks-modes-"));
  mkdirSync(join(home, ".trail"), { recursive: true, mode: 0o755 });
  writeFileSync(join(home, ".trail", "settings.json"), JSON.stringify({ skills: "on" }));
  const env = { HOME: home, TRAIL_HOME: join(home, ".trail"), CLAUDE_CODE_ENTRYPOINT: "cli", PATH: process.env.PATH };
  const transcript = join(home, "t.jsonl");
  writeFileSync(transcript, jsonl([ask("run the tests", 0), ...bash("npm test", "Tests  2 passed (2)", { sec: 1 }), ask("publish 1.4.3", 60)]));
  const g = skillsGate({ session_id: "s-modes", cwd: ROOT, transcript_path: transcript }, ROOT, env);
  assert.ok(g.ok && g.ctx.fold);
  withSkillSession(g.ctx, { catchUp: true }, (st) => { st.injected.push(injection()); writeGateFile("s-modes", st, env); });
  appendPostMark("s-modes", { id: "toolu_1", at: at(1), failed: false }, env);
  notePoolDay("github.com/acme/shop", { job: "tests", words: ["tests"] }, { d: "2026-10-01", s: "e76b4ca7f1a0", costly: true }, null, env, new Date(2026, 9, 1, 12));
  const sessions = join(home, ".trail", "sessions");
  const runs = join(home, ".trail", "runs");
  const files = [join(sessions, "s-modes.json"), gateFilePath("s-modes", env), join(sessions, "s-modes.post.jsonl"), join(runs, "index.json"), poolPath("github.com/acme/shop", env)];
  const sheet = readFileSync(join(runs, "index.json"), "utf8").match(/r-\d{4}-[0-9a-f]{4}/)![0];
  files.push(join(runs, `${sheet}.json`));
  for (const f of files) assert.equal(statSync(f).mode & 0o777, 0o600, f);
  for (const d of [sessions, runs, join(poolPath("github.com/acme/shop", env), "..")]) assert.equal(statSync(d).mode & 0o777, 0o700, d);
  assert.ok(!lstatSync(sessions).isSymbolicLink());
});

/* --------------------------------------------------- two hook processes at once */

const SKILL_SESSION = join(SRC, "trace", "skill-session.ts");

test("two hook processes catching up at once while the transcript grows: every call folded once, no update lost", { skip: !POSIX && "posix only", timeout: 90_000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), "breaks-race-"));
  mkdirSync(join(home, ".trail"), { recursive: true });
  writeFileSync(join(home, ".trail", "settings.json"), JSON.stringify({ skills: "on" }));
  const transcript = join(home, "t.jsonl");
  writeFileSync(transcript, jsonl([ask("run the integration tests", 0)]));
  const lines = Array.from({ length: 80 }, (_, i) => jsonl(bash(`npm run step:${i}`, "ok", { sec: 1 + i, id: `toolu_race_${i}` })));
  const writer = join(home, "writer.mjs");
  writeFileSync(writer, `import { appendFileSync } from "node:fs";
const lines = ${JSON.stringify(lines)};
for (const l of lines) { appendFileSync(${JSON.stringify(transcript)}, l); const until = Date.now() + 4; while (Date.now() < until) {} }`);
  const hook = join(home, "hook.mts");
  writeFileSync(hook, `const { skillsGate, withSkillSession } = await import(${JSON.stringify(SKILL_SESSION)});
const env = { ...process.env, HOME: ${JSON.stringify(home)}, TRAIL_HOME: ${JSON.stringify(join(home, ".trail"))}, CLAUDE_CODE_ENTRYPOINT: "cli" };
delete env.CI; delete env.GITHUB_ACTIONS; delete env.TRAIL_NO_HOOKS;
let lost = 0;
for (let i = 0; i < 30; i++) {
  const g = skillsGate({ session_id: "s-race", cwd: ${JSON.stringify(ROOT)}, transcript_path: ${JSON.stringify(transcript)} }, ${JSON.stringify(ROOT)}, env);
  const r = withSkillSession(g.ctx, { catchUp: true, waitMs: 20000 }, (st) => { st.scopeKeys.push("p" + process.pid + "-" + i); return 1; });
  if (r !== 1) lost++;
}
process.stdout.write(String(lost));`);
  const run = (file: string, loader: boolean) => new Promise<string>((done) => {
    let out = "";
    const p = spawn(process.execPath, loader ? ["--import", "tsx", file] : [file], { cwd: ROOT, stdio: ["ignore", "pipe", "inherit"] });
    p.stdout.on("data", (d) => (out += d));
    p.on("exit", () => done(out));
  });
  const outs = await Promise.all([run(hook, true), run(hook, true), run(writer, false)]);
  assert.deepEqual(outs.slice(0, 2), ["0", "0"], "a hook gave up on the lock");
  // One last catch-up after the writer is done.
  const env = { HOME: home, TRAIL_HOME: join(home, ".trail"), CLAUDE_CODE_ENTRYPOINT: "cli", PATH: process.env.PATH };
  const g = skillsGate({ session_id: "s-race", cwd: ROOT, transcript_path: transcript }, ROOT, env);
  assert.ok(g.ok);
  const st = withSkillSession(g.ctx, { catchUp: true, waitMs: 5000 }, (s) => s)!;
  assert.equal(st.runs.length, 1);
  assert.equal(st.runs[0]!.commands, 80, "every call folded exactly once");
  assert.equal(st.scopeKeys.filter((k) => k.startsWith("p")).length, 60, "no update lost");
});
