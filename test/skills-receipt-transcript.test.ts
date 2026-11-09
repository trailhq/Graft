/**
 * The CLI half reads the transcript the receipt names, so it accepts a
 * receipt only when that path, through realpath, is the host's own file for
 * that session: for Claude Code `<projects>/<folder>/<session_id>.jsonl`,
 * where <projects> is `~/.claude/projects` (HOME from the env, so the lab's
 * home counts) or `$CLAUDE_CONFIG_DIR/projects`. Anything else is held for
 * the person, with words that say why. Synthetic data only.
 */
process.env.TZ = "UTC";
import { test } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cliAdd, heldLines } from "../src/skills/save-gate.js";
import { receiptPath, receiptTranscriptOk } from "../src/skills/receipts.js";
import type { Receipt } from "../src/skills/types.js";
import { T, add, box, kept, offered, prompt, type Box } from "./skills-consent-fixtures.js";

const WHY = "Trail couldn't find this conversation where Claude Code keeps it, so it can't check that you said yes";

function receipt(over: Partial<Receipt> & { session: string; transcriptPath: string }): Receipt {
  return {
    v: 1, toolUseId: "toolu_0001", runId: "r-1027-0001", name: "release-npm", at: T(0).toISOString(), host: "claude", tier: "A",
    consent: "offer-yes", offerId: "o-0a0b0c", typed: null, typedYes: true, typedSave: false, asked: null,
    stepsTotal: 3, stepsVerified: 3, verdict: "live", usedAt: null, ...over,
  };
}

/** A home with one Claude Code project folder and one transcript in it. */
function home(): { home: string; env: NodeJS.ProcessEnv; sid: string; tx: string; folder: string } {
  const home = mkdtempSync(join(tmpdir(), "receipt-tx-"));
  const sid = "5f0c1a2b-3c4d-4e5f-8a9b-0000000000aa";
  const folder = join(home, ".claude", "projects", "-home-dev-shop");
  mkdirSync(folder, { recursive: true });
  const tx = join(folder, `${sid}.jsonl`);
  writeFileSync(tx, "");
  return { home, env: { HOME: home, TRAIL_HOME: join(home, "trail-home") }, sid, tx, folder };
}

test("receiptTranscriptOk: the session's own file in a Claude Code project folder", () => {
  const h = home();
  assert.equal(receiptTranscriptOk(receipt({ session: h.sid, transcriptPath: h.tx }), h.env), true);
  // Through a relative-looking path that resolves to the same file.
  assert.equal(receiptTranscriptOk(receipt({ session: h.sid, transcriptPath: join(h.folder, "..", "-home-dev-shop", `${h.sid}.jsonl`) }), h.env), true);
});

test("receiptTranscriptOk refuses /tmp/x.jsonl, a missing file and a relative path", () => {
  const h = home();
  const x = join(mkdtempSync(join(tmpdir(), "elsewhere-")), "x.jsonl");
  writeFileSync(x, "");
  assert.equal(receiptTranscriptOk(receipt({ session: h.sid, transcriptPath: x }), h.env), false);
  assert.equal(receiptTranscriptOk(receipt({ session: h.sid, transcriptPath: "/tmp/x.jsonl" }), h.env), false);
  assert.equal(receiptTranscriptOk(receipt({ session: h.sid, transcriptPath: join(h.folder, "gone.jsonl") }), h.env), false);
  assert.equal(receiptTranscriptOk(receipt({ session: h.sid, transcriptPath: `-home-dev-shop/${h.sid}.jsonl` }), h.env), false);
  assert.equal(receiptTranscriptOk(receipt({ session: h.sid, transcriptPath: "" }), h.env), false);
});

test("receiptTranscriptOk refuses a link from the projects folder to a file elsewhere, and a linked project folder", () => {
  const h = home();
  const away = mkdtempSync(join(tmpdir(), "elsewhere-"));
  const target = join(away, `${h.sid}.jsonl`);
  writeFileSync(target, "");
  const other = "5f0c1a2b-3c4d-4e5f-8a9b-0000000000bb";
  const link = join(h.folder, `${other}.jsonl`);
  symlinkSync(join(away, `${other}.jsonl`), link);
  writeFileSync(join(away, `${other}.jsonl`), "");
  assert.equal(receiptTranscriptOk(receipt({ session: other, transcriptPath: link }), h.env), false, "a file link");
  const linkedFolder = join(h.home, ".claude", "projects", "-home-dev-linked");
  symlinkSync(away, linkedFolder);
  assert.equal(receiptTranscriptOk(receipt({ session: h.sid, transcriptPath: join(linkedFolder, `${h.sid}.jsonl`) }), h.env), false, "a folder link");
});

test("receiptTranscriptOk refuses a session id that is not the file's name, and a file deeper than one folder", () => {
  const h = home();
  assert.equal(receiptTranscriptOk(receipt({ session: "5f0c1a2b-3c4d-4e5f-8a9b-0000000000cc", transcriptPath: h.tx }), h.env), false);
  const deep = join(h.folder, "sub");
  mkdirSync(deep);
  writeFileSync(join(deep, `${h.sid}.jsonl`), "");
  assert.equal(receiptTranscriptOk(receipt({ session: h.sid, transcriptPath: join(deep, `${h.sid}.jsonl`) }), h.env), false);
  writeFileSync(join(h.home, ".claude", "projects", `${h.sid}.jsonl`), "");
  assert.equal(receiptTranscriptOk(receipt({ session: h.sid, transcriptPath: join(h.home, ".claude", "projects", `${h.sid}.jsonl`) }), h.env), false, "not in a project folder");
});

test("receiptTranscriptOk honours CLAUDE_CONFIG_DIR and a linked ~/.claude (a dotfiles folder)", () => {
  const h = home();
  const cfg = mkdtempSync(join(tmpdir(), "claude-config-"));
  mkdirSync(join(cfg, "projects", "-home-dev-shop"), { recursive: true });
  const tx = join(cfg, "projects", "-home-dev-shop", `${h.sid}.jsonl`);
  writeFileSync(tx, "");
  assert.equal(receiptTranscriptOk(receipt({ session: h.sid, transcriptPath: tx }), h.env), false, "not without the variable");
  assert.equal(receiptTranscriptOk(receipt({ session: h.sid, transcriptPath: tx }), { ...h.env, CLAUDE_CONFIG_DIR: cfg }), true);
  const dots = mkdtempSync(join(tmpdir(), "dotfiles-"));
  mkdirSync(join(dots, "claude", "projects", "-home-dev-shop"), { recursive: true });
  const other = mkdtempSync(join(tmpdir(), "receipt-tx-linked-"));
  symlinkSync(join(dots, "claude"), join(other, ".claude"));
  const ltx = join(other, ".claude", "projects", "-home-dev-shop", `${h.sid}.jsonl`);
  writeFileSync(ltx, "");
  assert.equal(receiptTranscriptOk(receipt({ session: h.sid, transcriptPath: ltx }), { HOME: other }), true);
});

test("receiptTranscriptOk: another host's receipt can't be live, so it passes as is; one that claims tier A doesn't", () => {
  assert.equal(receiptTranscriptOk(receipt({ session: "s1", transcriptPath: "/home/dev/.cursor/x.jsonl", host: "cursor", tier: "D", verdict: "held" }), { HOME: "/home/dev" }), true);
  assert.equal(receiptTranscriptOk(receipt({ session: "s1", transcriptPath: "/home/dev/.cursor/x.jsonl", host: "cursor", tier: "A" }), { HOME: "/home/dev" }), false);
});

/** An offer, the person's yes, and the agent's add let through by PreToolUse (receipt written), the CLI not run yet. */
function yesAdded(): { b: Box; name: string; runId: string } {
  const b = box();
  const { offer } = offered(b, 0);
  prompt(b, 70, "yes");
  const r = add(b, 80, `trail skills add ${offer.name} --run ${offer.runId}`, { skipCli: true });
  assert.equal(r.decision, null);
  return { b, name: offer.name, runId: offer.runId };
}
function pointReceiptAt(b: Box, path: string): void {
  const p = receiptPath(b.sid, b.env);
  writeFileSync(p, JSON.stringify({ ...JSON.parse(readFileSync(p, "utf8")), transcriptPath: path }));
}

test("the CLI holds a receipt that names /tmp/x.jsonl, with words that say why", () => {
  const { b, name, runId } = yesAdded();
  const x = join(mkdtempSync(join(tmpdir(), "elsewhere-")), "x.jsonl");
  copyFileSync(b.tx, x);
  pointReceiptAt(b, x);
  const cli = cliAdd(name, runId, b.env, T(81), b.repo);
  assert.equal(cli.exit, 0);
  assert.equal(cli.saved, undefined);
  assert.equal(cli.held, "no-yes");
  assert.deepEqual(cli.lines, heldLines(name, "transcript", "claude"));
  assert.deepEqual(cli.lines, [
    `· not kept: ${WHY}`,
    `Tell the person why Trail didn't keep it: I didn't keep ${name} as a skill, because ${WHY}. If you want it, run this in your own terminal: trail skills keep ${name}`,
  ]);
  assert.doesNotMatch(cli.lines.join("\n"), /—/);
  assert.deepEqual(kept(b), { skills: [], held: [name] });
  assert.ok(JSON.parse(readFileSync(receiptPath(b.sid, b.env), "utf8")).usedAt, "the receipt is spent");
});

test("the CLI holds a receipt whose transcript is a link from the projects folder to a copy elsewhere", () => {
  const { b, name, runId } = yesAdded();
  const away = join(mkdtempSync(join(tmpdir(), "elsewhere-")), `${b.sid}.jsonl`);
  copyFileSync(b.tx, away);
  const folder = join(b.root, ".claude", "projects", "-home-dev-other");
  mkdirSync(folder, { recursive: true });
  const link = join(folder, `${b.sid}.jsonl`);
  symlinkSync(away, link);
  pointReceiptAt(b, link);
  const cli = cliAdd(name, runId, b.env, T(81), b.repo);
  assert.equal(cli.saved, undefined);
  assert.deepEqual(cli.lines, heldLines(name, "transcript", "claude"));
  assert.deepEqual(kept(b).skills, []);
});

test("the CLI holds a receipt whose transcript is another session's file (the id is not its name)", () => {
  const { b, name, runId } = yesAdded();
  const other = join(b.tx, "..", "5f0c1a2b-3c4d-4e5f-8a9b-0000000000ee.jsonl");
  copyFileSync(b.tx, other);
  pointReceiptAt(b, other);
  const cli = cliAdd(name, runId, b.env, T(81), b.repo);
  assert.equal(cli.saved, undefined);
  assert.deepEqual(cli.lines, heldLines(name, "transcript", "claude"));
  assert.deepEqual(kept(b).skills, []);
});

test("the session's own transcript still saves", () => {
  const { b, name, runId } = yesAdded();
  const cli = cliAdd(name, runId, b.env, T(81), b.repo);
  assert.deepEqual(cli.saved, { from: "repeated", scope: "personal" });
  assert.deepEqual(kept(b).skills, [name]);
});
