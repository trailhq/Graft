import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installCodexHooks } from "../src/hosts/codex-hooks.js";
import { editedFilePath } from "../src/claude/hooks.js";

function fresh(): string { return mkdtempSync(join(tmpdir(), "graft-cxhooks-")); }
import { mkdtempSync } from "node:fs";

const HAS_EXEC_BIT = process.platform !== "win32";

function assertRunnableShim(shim: string): void {
  assert.ok(existsSync(shim), "shim missing");
  if (HAS_EXEC_BIT) assert.ok(statSync(shim).mode & 0o111, "shim not executable");
}

test("no-op when the CLI home dir is absent", () => {
  assert.deepEqual(installCodexHooks(fresh()), []);
});

test("writes config TOML hooks and retires a Graft-only legacy JSON file", () => {
  const home = fresh();
  const base = join(home, ".codex");
  mkdirSync(base, { recursive: true });
  const legacy = {
    hooks: {
      Stop: [{ hooks: [{ type: "command", command: "node old/graft-hooks.cjs stop" }] }],
    },
  };
  writeFileSync(join(base, "hooks.json"), JSON.stringify(legacy));

  const writes = installCodexHooks(home);
  assert.deepEqual(writes.map((item) => item.action), ["created", "created", "deleted"]);
  const shim = join(base, "hooks", "graft", "graft-hooks.cjs");
  assertRunnableShim(shim);
  assert.ok(!existsSync(join(base, "hooks.json")), "legacy source was retired");

  const config = readFileSync(join(base, "config.toml"), "utf8");
  assert.match(config, /\[\[hooks\.UserPromptSubmit\]\][\s\S]*graft-hooks\.cjs\\\" prompt/);
  assert.match(config, /\[\[hooks\.SessionStart\]\][\s\S]*graft-hooks\.cjs\\\" session-start/);
  assert.match(config, /\[\[hooks\.PostToolUse\]\][\s\S]*graft-hooks\.cjs\\\" post-edit/);
  assert.match(config, /\[\[hooks\.Stop\]\][\s\S]*graft-hooks\.cjs\\\" stop/);
  assert.match(config, /matcher = "apply_patch\|Write\|Edit\|MultiEdit"/);

  const second = installCodexHooks(home);
  assert.deepEqual(second.map((item) => item.action), ["unchanged", "unchanged", "unchanged"]);
  assert.equal((readFileSync(join(base, "config.toml"), "utf8").match(/graft-hooks\.cjs/g) ?? []).length, 4);
});

test("preserves foreign hooks JSON without rewriting it", () => {
  const home = fresh();
  const base = join(home, ".codex");
  mkdirSync(base, { recursive: true });
  const original = JSON.stringify({
    hooks: {
      PostToolUse: [{ hooks: [{ type: "command", command: "other-tool" }] }],
    },
  });
  writeFileSync(join(base, "hooks.json"), original);

  const writes = installCodexHooks(home);
  assert.ok(writes.some((item) => item.id === "codex-hooks-legacy" && item.action === "unchanged"));
  assert.equal(readFileSync(join(base, "hooks.json"), "utf8"), original);
  assert.match(readFileSync(join(base, "config.toml"), "utf8"), /graft-hooks\.cjs/);
});

test("unparseable legacy JSON remains untouched", () => {
  const home = fresh();
  const base = join(home, ".codex");
  mkdirSync(base, { recursive: true });
  writeFileSync(join(base, "hooks.json"), "{ nope");

  const writes = installCodexHooks(home);
  assert.ok(writes.some((item) => item.action === "skipped-unparseable"));
  assert.equal(readFileSync(join(base, "hooks.json"), "utf8"), "{ nope");
});

test("rejects an existing TOML group that mixes Graft and foreign hooks", () => {
  const home = fresh();
  const base = join(home, ".codex");
  mkdirSync(base, { recursive: true });
  const original = "[[hooks.Stop]]\n\n[[hooks.Stop.hooks]]\ntype = \"command\"\ncommand = \"node graft-hooks.cjs stop\"\n\n[[hooks.Stop.hooks]]\ntype = \"command\"\ncommand = \"other-tool\"\n";
  writeFileSync(join(base, "config.toml"), original);

  const writes = installCodexHooks(home);
  assert.ok(writes.some((item) => item.id === "codex-hooks" && item.action === "skipped-unparseable"));
  assert.equal(readFileSync(join(base, "config.toml"), "utf8"), original);
});

test("editedFilePath accepts the Codex patch shape", () => {
  const patch = "*** Begin Patch\n*** Update File: src/b.ts\n@@\n-old\n+new\n*** End Patch";
  assert.equal(editedFilePath({ tool_input: { command: patch } }, "/repo"), join("/repo", "src/b.ts"));
});

test("re-heals a stripped shim exec bit", () => {
  const home = fresh();
  const base = join(home, ".codex");
  mkdirSync(base, { recursive: true });
  installCodexHooks(home);
  const shim = join(base, "hooks", "graft", "graft-hooks.cjs");
  if (HAS_EXEC_BIT) chmodSync(shim, 0o644);
  installCodexHooks(home);
  assertRunnableShim(shim);
});
