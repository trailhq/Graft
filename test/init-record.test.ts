/**
 * `~/.trail/init/<repo-key>.json` v2 (design 2.6): what earlier inits decided
 * here, read back strictly (the file is the agent's to edit), a phase 0 file
 * upgraded with its quotes and titles dropped (R33), and nothing typed in it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { emptyRecord, initRecordPath, MAX_RUNS, newRunId, pendingItems, readInitRecord, updateInitRecord, writeInitRecord, type InitRecord } from "../src/init/init-record.js";
import { timeBar } from "./machine-speed.js";

const KEY = "github.com/acme/shop";
const sha = "a".repeat(64);

function home(tag: string): { env: NodeJS.ProcessEnv; done: () => void } {
  const dir = mkdtempSync(join(tmpdir(), `graft-b6-rec-${tag}-`));
  return { env: { TRAIL_HOME: join(dir, ".trail"), HOME: dir }, done: () => rmSync(dir, { recursive: true, force: true }) };
}

const skillPending = {
  n: 1, id: "i-1f0e2a9c41", kind: "skill", key: "github.com/acme/shop|job:release", plainName: "release-npm", nameWords: ["release-npm"],
  count: { days: 21, from: "2026-07-03", to: "2026-10-14", costly: 14 }, applies: KEY, scope: "personal", typed: false, ticked: false,
  skill: { src: { t: "/home/dev/.claude/projects/-home-dev-shop/s1.jsonl", size: 4100, mtimeMs: 1728901212000, run: { from: 100, to: 900 }, prior: null, skillSha: sha } },
};
const prefPending = {
  n: 3, id: "i-c3d9e0b871", kind: "preference", key: "pref:0123456789abcdef", plainName: "", nameWords: ["explain", "simply"],
  count: { days: 12, from: "2026-07-03", to: "2026-10-14" }, applies: "every repo", scope: "personal", typed: true, ticked: true,
  pref: { refs: [{ t: "/home/dev/.claude/projects/-home-dev-shop/s1.jsonl", o: 1830, s: sha }] },
};

test("no file is an empty v2 record; a written one reads back the same, 0600 in a 0700 folder", () => {
  const h = home("rt");
  try {
    assert.deepEqual(readInitRecord(KEY, h.env), emptyRecord(KEY));
    const r: InitRecord = {
      ...emptyRecord(KEY),
      runs: [{ id: "ir-8c21", at: "2026-10-17T09:12:01.000Z", by: "agent", screen: "relay", reads: { sessions: 23, days: 21, from: "2026-07-03", to: "2026-10-14", parent: 15, read: ["a82f2c86d1e0"], skipped: [{ sh: "77c0e1aa5b31", why: "ancestor-under-30" }] }, model: "none", modelWhy: "agent", calls: 0, tokens: 0, ms: 41000, shown: ["i-1f0e2a9c41", "i-c3d9e0b871"], kept: [], closed: [], deferred: [] }],
      pending: [skillPending as never, { ...prefPending, nameWords: [] } as never],
      pendingFrom: "ir-8c21", shownAt: "2026-10-17T09:12:40.000Z", closed: ["i-77b10e3d02"], closedV1: ["9d2c0a1b2c3d4e5f"],
    };
    writeInitRecord(KEY, r, h.env);
    const back = readInitRecord(KEY, h.env);
    assert.deepEqual(back, r);
    assert.deepEqual(pendingItems(back).map((p) => p.n), [1, 3]);
    const path = initRecordPath(KEY, h.env);
    assert.equal(path, join(h.env.TRAIL_HOME!, "init", "github.com", "acme", "shop.json"));
    if (process.platform !== "win32") {
      assert.equal(statSync(path).mode & 0o777, 0o600);
      assert.equal(statSync(dirname(path)).mode & 0o777, 0o700);
    }
  } finally {
    h.done();
  }
});

test("a preference's name words are the person's words: never on disk, [] when read back", () => {
  const h = home("words");
  try {
    writeInitRecord(KEY, { ...emptyRecord(KEY), pending: [prefPending as never], pendingFrom: "ir-0001" }, h.env);
    const text = readFileSync(initRecordPath(KEY, h.env), "utf8");
    assert.doesNotMatch(text, /explain|simply/);
    assert.deepEqual(readInitRecord(KEY, h.env).pending[0]!.nameWords, []);
  } finally {
    h.done();
  }
});

test("a phase 0 (v1) file upgrades on read: pending and its quotes dropped, closed titles dropped, quote hashes kept (R33)", () => {
  const h = home("v1");
  try {
    const path = initRecordPath(KEY, h.env);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({
      pending: [{ from: "sessions", title: "Explain it simply", body: "## Decided\n- explain it simply", scope: "personal", typed: true, quotes: ["explain it simply, one example first"], days: 3, last: "2026-10-01" }],
      closed: [{ title: "Run go test with -race", quotes: ["0123456789abcdef", "not a hash"], at: "2026-10-02" }],
      shownAt: "2026-10-03T10:00:00Z",
    }));
    const r = readInitRecord(KEY, h.env);
    assert.equal(r.v, 2);
    assert.deepEqual(r.pending, []);
    assert.deepEqual(r.closedV1, ["0123456789abcdef"]);
    assert.deepEqual(r.closed, []);
    writeInitRecord(KEY, r, h.env);
    const text = readFileSync(path, "utf8");
    for (const words of ["Explain it simply", "explain it simply", "Run go test", "Decided"]) assert.ok(!text.includes(words), words);
  } finally {
    h.done();
  }
});

test("the file is the agent's to edit: anything of the wrong shape is dropped, not trusted", () => {
  const h = home("shape");
  try {
    const path = initRecordPath(KEY, h.env);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({
      v: 2, repo: KEY, runs: [{ id: "x" }, "y"],
      pending: [
        { ...skillPending, skill: { src: { ...skillPending.skill.src, run: { from: "a", to: 9 } } } },
        { ...skillPending, n: 0 },
        { ...skillPending, kind: "workflow" },
        { ...skillPending, id: "i-ZZ" },
        { ...prefPending, pref: { refs: [{ t: "/x.jsonl", o: -1, s: sha }] } },
        { ...prefPending, n: 2, title: "smuggled words", body: "SKILL.md text" },
        { ...prefPending, n: 5, id: "i-0000000005", key: "pref:explain it simply" },
        { n: 4, id: "i-0000000004", kind: "guardrail", key: "wall:not-a-wall", plainName: "no-timeout", nameWords: ["no-timeout"], count: { days: 6, from: "2026-07-09", to: "2026-10-02" }, applies: "every repo", scope: "personal", typed: false, ticked: false, guardrail: { cls: "not-a-wall" } },
      ],
      pendingFrom: 42, shownAt: "2026-10-17T09:12:40.000Z", handedAt: null, handover: { session: "s1", offset: "9" },
      closed: ["i-77b10e3d02", "nope", 7], closedV1: ["zz"], deferred: ["i-0123456789"],
    }));
    const r = readInitRecord(KEY, h.env);
    assert.deepEqual(r.runs, []);
    assert.deepEqual(r.pending.map((p) => p.n), [2], "only the well-shaped preference is left");
    assert.equal((r.pending[0] as unknown as Record<string, unknown>).title, undefined, "unknown fields never come back");
    assert.equal(r.pendingFrom, null);
    assert.equal(r.handover, null);
    assert.deepEqual(r.closed, ["i-77b10e3d02"]);
    assert.deepEqual(r.closedV1, []);
    assert.deepEqual(r.deferred, ["i-0123456789"]);
  } finally {
    h.done();
  }
});

test("runs keep the last 10; updateInitRecord reads, changes and writes under the file's lock", () => {
  const h = home("runs");
  try {
    for (let k = 0; k < MAX_RUNS + 3; k++) {
      updateInitRecord(KEY, (r) => {
        r.runs.push({ id: newRunId(), at: new Date(2026, 9, 1, 10, k).toISOString(), by: "person", screen: "tty", reads: { sessions: k, days: 0, from: null, to: null, parent: 0, read: [], skipped: [] }, model: "none", modelWhy: null, calls: 0, tokens: 0, ms: 0, shown: [], kept: [], closed: [], deferred: [] });
      }, h.env);
    }
    const r = readInitRecord(KEY, h.env);
    assert.equal(r.runs.length, MAX_RUNS);
    assert.equal(r.runs[0]!.reads.sessions, 3, "the oldest went first");
    assert.match(r.runs[0]!.id, /^ir-[0-9a-f]{4}$/);
  } finally {
    h.done();
  }
});

test("a FIFO planted at the record reads as no record, at once", { skip: process.platform === "win32" }, () => {
  const h = home("fifo");
  try {
    const path = initRecordPath(KEY, h.env);
    mkdirSync(dirname(path), { recursive: true });
    execFileSync("mkfifo", [path]);
    const t0 = Date.now();
    assert.deepEqual(readInitRecord(KEY, h.env), emptyRecord(KEY));
    assert.ok(Date.now() - t0 < timeBar(2000, 6000));
  } finally {
    h.done();
  }
});
