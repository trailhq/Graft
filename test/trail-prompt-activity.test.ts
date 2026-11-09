/**
 * The prompt hook's whole path in a repo connected to a Trail workspace: the
 * hook hands the prompt to its `ask` child on stdin, and that ask queues a use
 * of the learnings it showed. The use is counts and learning names: no word of
 * the prompt in the activity outbox, anywhere under ~/.trail, or in the repo.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { BRAND_ENV } from "../src/brand.js";
import { handlePrompt } from "../src/claude/prompt-hook.js";
import { writeCloud, type Cloud } from "../src/cloud/workspace.js";
import { buildGraph } from "../src/graph/build.js";
import { tmpRepo } from "./helpers.js";

const home = mkdtempSync(join(tmpdir(), "prompt-activity-home-"));
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.TRAIL_HOME = join(home, ".trail");
process.env.DO_NOT_TRACK = "1";
process.env.TRAIL_NO_FETCH = "1";
process.env[BRAND_ENV] = "trail";
delete process.env.CLAUDE_CONFIG_DIR;

const KEY = "github.com/acme/ledger";
const TOKEN = "Zebrafinchsynthetic";
const PROMPT = `how does the ledger rotate its signing keys for ${TOKEN}`;
const LEARNING = "2026-10-07-ledger-signing-keys-rotate-priya.md";

function git(cwd: string, ...args: string[]): void {
  const r = spawnSync("git", ["-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
}

/** Every file under `dir` whose text holds `needle`. */
function filesWith(dir: string, needle: string): string[] {
  if (!existsSync(dir)) return [];
  const hits: string[] = [];
  for (const e of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!e.isFile()) continue;
    const p = join(e.parentPath, e.name);
    if (readFileSync(p, "utf8").includes(needle)) hits.push(p);
  }
  return hits;
}

/** The real CLI from source, as the hook's `ask` child: argv and stdin passed through untouched. */
function cliFromSource(): string {
  const tsx = pathToFileURL(createRequire(import.meta.url).resolve("tsx/esm", { paths: [process.cwd()] })).href;
  const cli = join(process.cwd(), "src", "bin", "trail.ts");
  const wrapper = join(mkdtempSync(join(tmpdir(), "prompt-activity-cli-")), "trail-cli.cjs");
  writeFileSync(
    wrapper,
    [
      "const { spawnSync } = require('child_process');",
      `const r = spawnSync(process.execPath, ['--import', ${JSON.stringify(tsx)}, ${JSON.stringify(cli)}, ...process.argv.slice(2)], { stdio: 'inherit' });`,
      "process.exit(r.status === null ? 1 : r.status);",
    ].join("\n"),
  );
  return wrapper;
}

test("a prompt's ask in a connected repo queues a use of the learnings, never a word of the prompt", async () => {
  const d = tmpRepo("prompt-activity");
  mkdirSync(join(d, "src"));
  writeFileSync(join(d, "src", "ledger.ts"), "export function rotateSigningKeys(ledger: string): string {\n  return ledger + ' rotated';\n}\n");
  mkdirSync(join(d, ".trail", "learnings"), { recursive: true });
  writeFileSync(
    join(d, ".trail", "learnings", LEARNING),
    "---\ntitle: Ledger signing keys rotate weekly\nauthor: Priya\ndate: 2026-10-07\ntouches:\n  - src/ledger.ts\n---\n## Decided\nRotate the ledger signing keys weekly, never on deploy.\n",
  );
  // A generous budget for the ask child (read in ms): it starts from source, slower than a built install.
  mkdirSync(join(d, ".claude"));
  writeFileSync(
    join(d, ".claude", "settings.json"),
    JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: 'node ".claude/helpers/trail-hooks.cjs" prompt', timeout: 60_000 }] }] } }),
  );
  git(d, "init", "-q", "-b", "main");
  git(d, "config", "user.name", "Priya Raman");
  git(d, "config", "user.email", "priya@acme.test");
  git(d, "add", "-A");
  git(d, "commit", "-qm", "init");
  git(d, "remote", "add", "origin", `https://${KEY}.git`);
  await buildGraph(d);
  const cloud: Cloud = {
    url: "http://trail.test",
    token: "trl_x",
    user: { name: "Priya", email: "priya@acme.test" },
    workspace: { id: "w", name: "Acme", slug: "acme", url: "http://trail.test/w/acme", invite_url: "http://trail.test/join/x" },
    repos: [KEY],
    linkedAt: Date.now() - 60_000,
  };
  writeCloud(cloud);

  const write = process.stdout.write.bind(process.stdout);
  let said = "";
  process.stdout.write = ((chunk: unknown, ...rest: unknown[]) => (typeof chunk === "string" ? ((said += chunk), true) : (write as (...a: unknown[]) => boolean)(chunk, ...rest))) as typeof process.stdout.write;
  process.env.CLAUDE_PROJECT_DIR = d;
  process.env.GRAFT_TEST_CLI = cliFromSource();
  try {
    // The hook's own budget is 4 s; an ask child started from source through tsx can take longer than that on a
    // slow runner (Windows), so the hook is given the installed 60 s here: what is under test is what the child keeps.
    await handlePrompt({ session_id: "s1", prompt: PROMPT }, d, { budgetMs: 60_000 });
  } finally {
    process.stdout.write = write;
    delete process.env.GRAFT_TEST_CLI;
    delete process.env.CLAUDE_PROJECT_DIR;
  }
  assert.match(said, /Ledger signing keys rotate weekly/, "the hook brought the learning");

  const outbox = join(process.env.TRAIL_HOME!, "outbox.jsonl");
  assert.ok(existsSync(outbox), "the ask child queued a use");
  const uses = readFileSync(outbox, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(uses.length, 1);
  assert.equal(uses[0].kind, "search");
  assert.deepEqual(uses[0].shown_paths, [LEARNING]);
  assert.equal(uses[0].query, undefined);
  for (const word of [TOKEN, "how does the ledger"]) {
    assert.deepEqual(filesWith(home, word), [], `a file under HOME holds the prompt (${word})`);
    assert.deepEqual(filesWith(d, word), [], `a file in the repo holds the prompt (${word})`);
  }
});
