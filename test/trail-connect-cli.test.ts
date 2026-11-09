/**
 * `trail init --connect <CODE>` end to end, against a fake Trail over real
 * HTTP: the code is claimed, the token saved where `trail login` keeps it,
 * the page's stages go up in order around init's usual work, and one summary
 * of the repo (tokens on one lookup, learnings, teammates' branches) goes up
 * before `done`. A wrong code stops before anything is written; an offline
 * Trail doesn't stop init; without --connect, nothing goes anywhere.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GOOD_CODE, TOKEN, startFakeTrail, type FakeTrail } from "./fake-trail-server.js";
import { writeNote } from "../src/notes/notes.js";
import { buildGraph } from "../src/graph/build.js";
import { BRAND_ENV } from "../src/brand.js";

process.env.DO_NOT_TRACK = "1";
process.env[BRAND_ENV] = "trail";

let trail: FakeTrail | null = null;
after(async () => {
  await trail?.close();
});

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync("git", ["-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout;
}

/** A distinctive line of code, so the test can tell if any code went up. */
const CODE_MARK = "return attempts * 7919";

/** A "GitHub" remote with a hub file, me with history on it, and Kumar's fresh branch changing it. */
function repoWithTeam(): string {
  const root = mkdtempSync(join(tmpdir(), "connect-cli-"));
  const bare = join(root, "retry.git");
  git(root, "init", "-q", "--bare", "-b", "main", bare);
  const seed = join(root, "seed");
  git(root, "init", "-q", "-b", "main", seed);
  const filler = Array.from({ length: 300 }, (_, i) => `export function helper${i}(x: number): number {\n  return x * ${i} + ${i};\n}\n`).join("\n");
  writeFileSync(join(seed, "client.ts"), `export function retryDo(attempts: number): number {\n  ${CODE_MARK};\n}\n\n${filler}`);
  for (const f of ["a", "b", "c"]) writeFileSync(join(seed, `${f}.ts`), `import { retryDo } from "./client";\nexport function use${f}() {\n  return retryDo(4);\n}\n`);
  git(seed, "add", "-A");
  git(seed, "-c", "user.name=Seed", "-c", "user.email=s@x", "commit", "-qm", "init");
  git(seed, "push", "-q", bare, "main");
  const clone = (who: string, name: string) => {
    const d = join(root, who);
    git(root, "clone", "-q", bare, d);
    git(d, "remote", "set-url", "origin", "https://github.com/acme/retry.git");
    git(d, "config", `url.${bare}.insteadOf`, "https://github.com/acme/retry.git");
    git(d, "config", "user.name", name);
    git(d, "config", "user.email", `${who}@acme.test`);
    git(d, "remote", "set-head", "origin", "main");
    return d;
  };
  const me = clone("rushabh", "Rushabh Nagda");
  writeFileSync(join(me, "client.ts"), readFileSync(join(me, "client.ts"), "utf8").replace("attempts * 7919", "attempts * 7907"));
  writeNote(me, { title: "Keep retryDo() at 4 attempts", body: "## Decided\n- Keep retryDo() at 4 attempts.\n\n_Told to Claude in 3 past sessions here, most recently on Oct 9._", author: "Rushabh", date: "2026-10-09", touches: ["client.ts"] });
  git(me, "add", "-A");
  git(me, "commit", "-qm", "Tune retryDo");

  const kumar = clone("kumar", "Kumar S");
  git(kumar, "checkout", "-q", "-b", "kumar/retry");
  writeFileSync(join(kumar, "client.ts"), readFileSync(join(kumar, "client.ts"), "utf8").replace("retryDo(attempts: number)", "retryDo(attempts: number, cap = 10)"));
  git(kumar, "commit", "-qam", "Raise the retry count to 10");
  git(kumar, "push", "-q", "origin", "kumar/retry");
  git(me, "fetch", "-q", "origin");
  return me;
}

function run(args: string[], env: NodeJS.ProcessEnv): Promise<{ status: number | null; stderr: string; stdout: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--import", "tsx", join(process.cwd(), "src", "bin", "trail.ts"), ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

function envFor(url: string): NodeJS.ProcessEnv {
  const home = mkdtempSync(join(tmpdir(), "connect-cli-home-"));
  return {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    TRAIL_HOME: join(home, ".trail"),
    TRAIL_TEST_SERVER: url,
    // No past-session or PR-review read (those ask Claude and GitHub), and no git fetch.
    TRAIL_NO_FETCH: "1",
    DO_NOT_TRACK: "1",
    TRAIL_INVOKED_AS: "trail",
  };
}

test("init --connect claims the code, sends the stages in order around init, and a summary with no code in it", async () => {
  trail = await startFakeTrail();
  const repo = repoWithTeam();
  // Built here: init's own build runs `node --import tsx` from inside the repo, where tsx isn't installed.
  await buildGraph(repo);
  const env = envFor(trail.url);
  const r = await run(["init", repo, "--connect", "trl-good-c0de", "--agents", "claude", "--no-global"], env);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /^✓ connected to workspace Acme$/m);
  // init's own output is all still there.
  assert.match(r.stderr, /✓ graph ready · /);
  assert.match(r.stderr, /✓ claude/);
  assert.match(r.stderr, /✓ sent Acme a summary: one lookup saved \d+% of the tokens, 1 learning, 1 teammate branch on your files/);

  const log = trail.log.filter((l) => l.path.startsWith("/api/"));
  assert.deepEqual(
    log.map((l) => (l.path === "/api/cli/onboarding/events" ? `stage:${l.body.stage}` : l.path)),
    ["/api/public/cli/connect", "stage:connected", "stage:mapped", "stage:learned", "/api/cli/repos/summary", "stage:done"],
  );
  const connect = log[0]!;
  assert.equal(connect.body.code, GOOD_CODE);
  assert.deepEqual(connect.body.repo, { name: "retry", remote_url: "https://github.com/acme/retry" });
  assert.equal(typeof connect.body.machine, "string");
  assert.ok(log.slice(1).every((l) => l.auth === `Bearer ${TOKEN}`));

  const mapped = log.find((l) => l.body?.stage === "mapped")!;
  assert.ok(mapped.body.data.nodes > 0 && mapped.body.data.edges > 0 && mapped.body.data.files === 4, JSON.stringify(mapped.body.data));
  const learned = log.find((l) => l.body?.stage === "learned")!;
  assert.deepEqual(learned.body.data, { learnings: 1, sessions: 3 });

  const summary = log.find((l) => l.path === "/api/cli/repos/summary")!.body;
  assert.deepEqual(summary.repo, { name: "retry", remote_url: "https://github.com/acme/retry" });
  assert.equal(summary.tokens.symbol, "retryDo");
  assert.ok(summary.tokens.saved > 0 && summary.tokens.baseline > summary.tokens.pack);
  assert.deepEqual(summary.learnings, [{ title: "Keep retryDo() at 4 attempts", body: "Keep retryDo() at 4 attempts.", sessions: 3 }]);
  assert.equal(summary.sessions, 3);
  assert.equal(summary.teammates.length, 1);
  assert.deepEqual(
    { ...summary.teammates[0], pushed_at: undefined },
    {
      name: "Kumar S",
      email: "kumar@acme.test",
      branch: "kumar/retry",
      files: ["client.ts"],
      change: "Raise the retry count to 10",
      commits: 1,
      conflict: 'Changes retryDo in client.ts, which your learning "Keep retryDo() at 4 attempts" is about.',
      pushed_at: undefined,
    },
  );
  // Route B: titles, counts and names. No code, from this clone or Kumar's branch.
  const everything = JSON.stringify(trail.log);
  for (const code of ["attempts *", "export function", "helper1", "cap = 10"]) assert.ok(!everything.includes(code), `sent code: ${code}`);

  // The token is kept where `trail login` keeps it, owner-only.
  const cloudPath = join(env.TRAIL_HOME!, "cloud.json");
  const cloud = JSON.parse(readFileSync(cloudPath, "utf8"));
  assert.equal(cloud.token, TOKEN);
  assert.equal(cloud.via, "connect");
  assert.equal(cloud.workspace.name, "Acme");
  assert.deepEqual(cloud.repos, []);
  if (process.platform !== "win32") assert.equal(statSync(cloudPath).mode & 0o777, 0o600);

  // Connected, the workspace commands show in help.
  const help = await run(["--help"], env);
  assert.match(help.stdout, /workspace/);
});

test("a wrong or spent code stops before anything is written", async () => {
  trail ??= await startFakeTrail();
  const repo = repoWithTeam();
  const env = envFor(trail.url);
  const r = await run(["init", repo, "--connect", "TRL-USED-C0DE", "--agents", "claude", "--no-global"], env);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /✗ that code was already used, has expired, or isn't right · get a new code at http:\/\/127\.0\.0\.1:\d+\/welcome\/code/);
  assert.equal(existsSync(join(repo, ".claude", "settings.json")), false);
  assert.equal(existsSync(join(env.TRAIL_HOME!, "cloud.json")), false);

  const bad = await run(["init", repo, "--connect", "nope"], env);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /isn't a Trail code/);
});

test("offline, init still sets the repo up and says how to connect later", async () => {
  const repo = repoWithTeam();
  const env = envFor("http://127.0.0.1:9");
  const r = await run(["init", repo, "--connect", GOOD_CODE, "--agents", "claude", "--no-global", "--no-build"], env);
  assert.equal(r.status, 0, r.stderr);
  // Said once, naming the Trail it tried, with the exact command that reaches it again.
  const said = r.stderr.split("\n").filter((l) => /reach Trail|Trail at /.test(l));
  assert.deepEqual(said, [
    "· couldn't reach Trail at http://127.0.0.1:9 · set this repo up anyway · to connect it later: trail init --connect TRL-GOOD-C0DE --server http://127.0.0.1:9",
  ]);
  assert.equal((r.stderr.match(/couldn't reach Trail/g) ?? []).length, 1);
  assert.ok(existsSync(join(repo, ".claude", "settings.json")));
  assert.equal(existsSync(join(env.TRAIL_HOME!, "cloud.json")), false);

  // The same with --server: the hint carries the --server that was used.
  const flagged = await run(["init", repo, "--connect", GOOD_CODE, "--server", "http://127.0.0.1:9/", "--agents", "claude", "--no-global", "--no-build"], { ...env, TRAIL_TEST_SERVER: "" });
  assert.equal(flagged.status, 0, flagged.stderr);
  assert.equal((flagged.stderr.match(/couldn't reach Trail/g) ?? []).length, 1);
  assert.match(flagged.stderr, /to connect it later: trail init --connect TRL-GOOD-C0DE --server http:\/\/127\.0\.0\.1:9$/m);
});

test("without --connect, init sends nothing anywhere and prints what it always did", async () => {
  trail ??= await startFakeTrail();
  const before = trail.log.length;
  const repo = repoWithTeam();
  const env = envFor(trail.url);
  const r = await run(["init", repo, "--agents", "claude", "--no-global", "--no-build"], env);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(trail.log.length, before);
  assert.doesNotMatch(r.stderr, /connected to workspace|summary/);
  assert.equal(existsSync(join(env.TRAIL_HOME!, "cloud.json")), false);
});

test("connected with Claude Code wired, Claude Code gets one user-level trail entry that serves the brains, and logout takes it out", async () => {
  trail ??= await startFakeTrail();
  const repo = repoWithTeam();
  await buildGraph(repo);
  const env = { ...envFor(trail.url), GRAFT_MCP_NPX: "1" };
  const r = await run(["init", repo, "--connect", GOOD_CODE, "--agents", "claude"], env);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /✓ Claude Code gets your team's learnings and skills in every project · restart it to pick them up$/m);
  const claudeJson = join(env.HOME!, ".claude.json");
  assert.deepEqual(JSON.parse(readFileSync(claudeJson, "utf8")).mcpServers.trail, { command: "npx", args: ["-y", "@trailhq/trail-code", "mcp", "--brains"] });

  // A plain init later keeps it: it isn't the repo-tools server trail stopped giving Claude Code.
  const again = await run(["init", repo, "--agents", "claude", "--no-build"], env);
  assert.equal(again.status, 0, again.stderr);
  assert.ok(JSON.parse(readFileSync(claudeJson, "utf8")).mcpServers.trail);

  const out = await run(["logout"], env);
  assert.equal(out.status, 0, out.stderr);
  assert.equal(JSON.parse(readFileSync(claudeJson, "utf8")).mcpServers.trail, undefined);
  assert.equal(existsSync(join(env.TRAIL_HOME!, "cloud.json")), false);
});

test("--server points the connect at another Trail, and the connection remembers it", async () => {
  trail ??= await startFakeTrail();
  const repo = repoWithTeam();
  const env = envFor("http://127.0.0.1:9");
  const r = await run(["init", repo, "--connect", GOOD_CODE, "--server", `${trail.url}/`, "--agents", "claude", "--no-global", "--no-build"], env);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /✓ connected to workspace Acme/);
  assert.equal(JSON.parse(readFileSync(join(env.TRAIL_HOME!, "cloud.json"), "utf8")).url, trail.url);
  const bad = await run(["init", repo, "--connect", GOOD_CODE, "--server", "dev.trailhq.com"], env);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /--server takes a URL/);
});
