/**
 * b6 review of the naming call: a call that times out, one that exits
 * non-zero with noise on stderr, and a name the model gives one skill that
 * is another skill's plain name. The words point at what actually looks
 * again (`trail init --look-back`). A `claude` stand-in on PATH only.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nameItems, nameLine } from "../src/init/name-call.js";
import { compiled, skillCandidate } from "./init-screen-fixtures.js";
import { jsLit } from "./escape.js";

const TYPED = ["always publish with the beta tag first", "explain it simply, one example first"];
const HOWTO = "To publish: npm version patch, npm publish, then npm view acme-cli version.";

function standIn(answer: unknown, opts: { fail?: string; sleepMs?: number; stderr?: string } = {}): { bin: string; calls: () => number; sent: () => string; done: () => void } {
  const bin = mkdtempSync(join(tmpdir(), "graft-b6-claude-"));
  const out = opts.fail ?? JSON.stringify({ is_error: false, total_cost_usd: 0.001, structured_output: answer });
  writeFileSync(join(bin, "claude"), [
    "#!/usr/bin/env node",
    `const fs = require("fs");`,
    `if (process.argv.includes("--version")) { fs.appendFileSync(${jsLit(join(bin, "version-calls"))}, "v\\n"); console.log("9.9.9"); process.exit(0); }`,
    `fs.appendFileSync(${jsLit(join(bin, "calls"))}, "-p\\n");`,
    `fs.writeFileSync(${jsLit(join(bin, "args"))}, JSON.stringify(process.argv));`,
    `let s = ""; process.stdin.on("data", (b) => (s += b)); process.stdin.on("end", () => setTimeout(() => { fs.writeFileSync(${jsLit(join(bin, "sent"))}, s); process.stderr.write(${jsLit(opts.stderr ?? "")}); console.log(${jsLit(out)}); process.exit(${opts.fail ? 1 : 0}); }, ${opts.sleepMs ?? 0}));`,
  ].join("\n"));
  chmodSync(join(bin, "claude"), 0o755);
  return {
    bin,
    calls: () => (existsSync(join(bin, "calls")) ? readFileSync(join(bin, "calls"), "utf8").split("\n").filter(Boolean).length : 0),
    sent: () => (existsSync(join(bin, "sent")) ? readFileSync(join(bin, "sent"), "utf8") + readFileSync(join(bin, "args"), "utf8") : ""),
    done: () => rmSync(bin, { recursive: true, force: true }),
  };
}

async function withPath<T>(bin: string, fn: (env: NodeJS.ProcessEnv) => Promise<T>): Promise<T> {
  const home = mkdtempSync(join(tmpdir(), "graft-b6-namehome-"));
  const saved = process.env.PATH;
  process.env.PATH = `${bin}:${saved}`;
  try {
    return await fn({ HOME: home, TRAIL_HOME: join(home, ".trail"), PATH: process.env.PATH });
  } finally {
    process.env.PATH = saved;
    rmSync(home, { recursive: true, force: true });
  }
}


const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/;

/** The stand-ins are shebang scripts on a ':'-joined PATH, which Windows can't run. */
const posixOnly = { skip: process.platform === "win32" ? "shebang stand-ins" : false };

test("a naming call that runs past its time gives plain names, and the line says a minute and how to try again", posixOnly, async () => {
  const s = standIn({ findings: [{ id: "i-1f0e2a9c41", name: "late-name", description: "too late" }] }, { sleepMs: 5000 });
  try {
    const t0 = Date.now();
    const r = await withPath(s.bin, (env) => nameItems([skillCandidate()], env, { timeoutMs: 300 }));
    assert.ok(Date.now() - t0 < 4500, "init never waits for it");
    assert.equal(r.why, "timed_out");
    assert.deepEqual(r.names, {});
    const line = nameLine(r, ["release-npm"], 0)!;
    assert.ok(!/3 minutes/.test(line), line);
    assert.match(line, /plain names/);
    assert.match(line, /trail init --look-back/);
  } finally {
    s.done();
  }
});

test("a naming call that exits non-zero gives plain names; Claude Code's own words reach the screen as one plain line", posixOnly, async () => {
  const s = standIn(null, { fail: "boom\u001b[2J\u0007 internal error", stderr: "\u001b]0;owned\u0007trace\n" });
  try {
    const r = await withPath(s.bin, (env) => nameItems([skillCandidate()], env));
    assert.equal(r.why, "failed");
    const line = nameLine(r, ["release-npm"], 0)!;
    assert.ok(!CONTROL.test(line), JSON.stringify(line));
    assert.match(line, /trail init --look-back/);
    assert.ok(!/trail init again/.test(line), "plain trail init doesn't look back again once it has");
  } finally {
    s.done();
  }
});

test("a name the model gives one skill that is another listed skill's plain name falls back", posixOnly, async () => {
  const other = { ...skillCandidate("i-2a2a2a2a2a", compiled("tests-cli", ["npm ci", "npm test"])), key: "github.com/acme/cli|job:tests", plainName: "tests-cli", nameWords: ["tests-cli"] };
  const s = standIn({ findings: [{ id: "i-1f0e2a9c41", name: "tests-cli", description: "Runs the tests." }] });
  try {
    const r = await withPath(s.bin, (env) => nameItems([skillCandidate(), other], env));
    assert.equal(r.names["i-1f0e2a9c41"], undefined, "two items would show and save under one name");
  } finally {
    s.done();
  }
});
