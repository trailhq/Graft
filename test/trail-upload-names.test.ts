/**
 * A use of the learnings sent to a Trail workspace names only learnings the
 * workspace itself got: the ones committed at HEAD or on a pushed branch. A
 * learning's file name carries the first words of its title, so a personal
 * learning, and one not yet committed, stay on this machine name and all.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { BRAND_ENV } from "../src/brand.js";
import { dropActivity, flushActivity, syncRepo } from "../src/cloud/workspace-sync.js";
import { isError, writeCloud, type Cloud } from "../src/cloud/workspace.js";
import { cacheDir } from "../src/util/state.js";
import { tmpRepo } from "./helpers.js";
import { escapeRe } from "./escape.js";

process.env.DO_NOT_TRACK = "1";
process.env[BRAND_ENV] = "trail";
process.env.TRAIL_NO_FETCH = "1";
process.env.TRAIL_HOME = mkdtempSync(join(tmpdir(), "upload-names-home-"));

const KEY = "github.com/acme/extract";

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync("git", ["-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout;
}

const learning = (title: string, touches: string, body: string, date = "2026-10-07") =>
  `---\ntitle: ${title}\nauthor: Priya\ndate: ${date}\ntouches:\n  - ${touches}\n---\n${body}\n`;

/** A connection, and a fake Trail that records what it's sent. */
function cloudFor(repos: string[]) {
  const sent: Array<{ path: string; raw: string; body: any }> = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname;
    const raw = init.body ? String(init.body) : "";
    const body = raw ? JSON.parse(raw) : undefined;
    sent.push({ path, raw, body });
    const json = (status: number, b: unknown) => new Response(JSON.stringify(b), { status });
    if (path === "/api/cli/learnings") return json(200, { repo: body.repo.key, learnings: body.learnings.length, added: 0 });
    if (path === "/api/cli/activity") return json(200, { stored: body.events.length });
    return json(404, { error: "no route" });
  }) as typeof fetch;
  const cloud: Cloud = {
    url: "http://trail.test",
    token: "trl_x",
    user: { name: "Priya", email: "priya@acme.test" },
    workspace: { id: "w", name: "Acme", slug: "acme", url: "http://trail.test/w/acme", invite_url: "http://trail.test/join/x" },
    repos,
    linkedAt: Date.now() - 60_000,
  };
  return { cloud, sent, fetchImpl };
}

const down = (async () => {
  throw new Error("offline");
}) as typeof fetch;

/**
 * A GitHub-backed repo with `files` committed, connected to the workspace
 * from a scratch HOME, and `trail` to run there. `personal` is where this
 * person's own learnings for the repo live.
 */
function scratch(tag: string, files: Record<string, string>) {
  const home = mkdtempSync(join(tmpdir(), `upload-names-${tag}-`));
  const trailHome = join(home, ".trail");
  const d = tmpRepo(`upload-names-${tag}`);
  for (const [p, text] of Object.entries(files)) {
    mkdirSync(dirname(join(d, p)), { recursive: true });
    writeFileSync(join(d, p), text);
  }
  git(d, "init", "-q", "-b", "main");
  git(d, "config", "user.name", "Priya Raman");
  git(d, "config", "user.email", "priya@acme.test");
  git(d, "add", "-A");
  git(d, "commit", "-qm", "init");
  git(d, "remote", "add", "origin", `https://${KEY}.git`);
  const env = { ...process.env, HOME: home, USERPROFILE: home, TRAIL_HOME: trailHome, DO_NOT_TRACK: "1", TRAIL_NO_FETCH: "1", CLAUDECODE: undefined, TRAIL_INVOKED_AS: undefined, CLAUDE_CODE_SESSION_ID: `s-${tag}` };
  const cli = (args: string[]) => spawnSync(process.execPath, ["--import", "tsx", join(process.cwd(), "src", "bin", "trail.ts"), ...args], { encoding: "utf8", env, timeout: 120_000 });
  const trail = cloudFor([KEY]);
  writeCloud(trail.cloud, { ...process.env, TRAIL_HOME: trailHome });
  const personal = join(trailHome, "repos", ...KEY.split("/"), "notes");
  mkdirSync(personal, { recursive: true });
  return { trailHome, d, cli, personal, ...trail };
}

/** Run `fn` with this process's ~/.trail at `trailHome`, as the background sync there would. */
async function inHome<T>(trailHome: string, fn: () => Promise<T>): Promise<T> {
  const saved = process.env.TRAIL_HOME;
  process.env.TRAIL_HOME = trailHome;
  try {
    return await fn();
  } finally {
    process.env.TRAIL_HOME = saved;
  }
}

const outboxText = (trailHome: string) => {
  const p = join(trailHome, "outbox.jsonl");
  return existsSync(p) ? readFileSync(p, "utf8") : "";
};

const BBOX_GO = "package ocr\n\nfunc NormalizeBox(x float64, rotate int) float64 {\n\treturn x\n}\n";
const COMMITTED = "2026-10-07-bbox-rotated-pdf-priya.md";
const committedBbox = learning("Bbox coordinates are off on rotated PDFs", "internal/ocr/bbox.go", "## Decided\nRotate each box by its page's /Rotate before scaling.");
const QUERY = "bbox rotated pdf";

test("a search never names a personal learning: not in the outbox, not in what's sent", async () => {
  const s = scratch("personal", { "internal/ocr/bbox.go": BBOX_GO, [`.trail/learnings/${COMMITTED}`]: committedBbox });
  const mine = "2026-10-09-bbox-personal-skpersonal999-priya.md";
  writeFileSync(join(s.personal, mine), learning("Bbox personal skpersonal999 rotated pdf", "internal/ocr/bbox.go", "## Watch out\nPersonal only, synthetic.", "2026-10-09"));
  assert.equal(s.cli(["build", s.d]).status, 0);

  const ask = s.cli(["ask", QUERY, s.d, "--json", "-n", "3"]);
  assert.equal(ask.status, 0, ask.stderr);
  const shown = (JSON.parse(ask.stdout).notes ?? []).map((h: any) => h.note.path as string);
  assert.ok(shown.some((p: string) => p.endsWith(mine)), "the personal learning was shown to the agent");
  assert.ok(shown.some((p: string) => p.endsWith(COMMITTED)), "and so was the committed one");

  const queued = outboxText(s.trailHome);
  assert.ok(!queued.includes("skpersonal999"), "queued its name");
  assert.deepEqual(JSON.parse(queued.trim()).shown_paths, [COMMITTED]);

  await inHome(s.trailHome, async () => {
    await syncRepo(s.d, s.cloud, { fetch: false, fetchImpl: s.fetchImpl });
    assert.equal(await flushActivity(s.cloud, s.fetchImpl), 1);
  });
  const req = s.sent.find((x) => x.path === "/api/cli/activity")!;
  assert.ok(!req.raw.includes("skpersonal999"), "sent its name");
  assert.deepEqual(req.body.events[0].shown_paths, [COMMITTED]);
  assert.deepEqual(req.body.events[0].shown_authors, ["Priya"]);
});

test("a search never sends the name of a learning git doesn't have at HEAD, nor keeps it to send later", async () => {
  const s = scratch("untracked", { "internal/ocr/bbox.go": BBOX_GO, [`.trail/learnings/${COMMITTED}`]: committedBbox });
  const draft = "2026-10-08-bbox-uncommitted-globexdraft-priya.md";
  writeFileSync(join(s.d, ".trail", "learnings", draft), learning("Bbox uncommitted globexdraft rotated pdf", "internal/ocr/bbox.go", "## Decided\nUntracked draft.", "2026-10-08"));
  assert.equal(s.cli(["build", s.d]).status, 0);

  const ask = s.cli(["ask", QUERY, s.d, "--json", "-n", "3"]);
  assert.equal(ask.status, 0, ask.stderr);
  const shown = (JSON.parse(ask.stdout).notes ?? []).map((h: any) => h.note.path as string);
  assert.ok(shown.some((p: string) => p.endsWith(draft)), "the untracked learning was shown to the agent");

  await inHome(s.trailHome, async () => {
    await syncRepo(s.d, s.cloud, { fetch: false, fetchImpl: s.fetchImpl });
    // Trail down: what's put back for next time has lost the name too.
    assert.equal(await flushActivity(s.cloud, down), 0);
    assert.ok(outboxText(s.trailHome).trim(), "the use is kept");
    assert.ok(!outboxText(s.trailHome).includes("globexdraft"), "kept its name to send later");
    assert.equal(await flushActivity(s.cloud, s.fetchImpl), 1);
  });
  for (const x of s.sent) assert.ok(!x.raw.includes("globexdraft"), `sent its name to ${x.path}`);
  const req = s.sent.find((x) => x.path === "/api/cli/activity")!;
  assert.deepEqual(req.body.events[0].shown_paths, [COMMITTED]);
  assert.deepEqual(req.body.events[0].shown_authors, ["Priya"]);
});

test("a check never names a personal learning it checked against", async () => {
  const name = "2026-10-03-ocr-retries-priya.md";
  const s = scratch("check", {
    "internal/ocr/client.go": "package ocr\n\nconst retries = 3\n",
    [`.trail/learnings/${name}`]: learning("OCR retries lock us out", "internal/ocr/client.go", "## Watch out\n- 5 retries got us locked out for a minute.", "2026-10-03"),
  });
  const mine = "2026-10-04-webhook-skpersonal999-priya.md";
  writeFileSync(join(s.personal, mine), learning("Webhook skpersonal999 retries", "internal/ocr/client.go", "## Decided\nThree retries with jitter.", "2026-10-04"));
  writeFileSync(join(s.d, "internal", "ocr", "client.go"), "package ocr\n\nconst retries = 5\n");

  const check = s.cli(["check", s.d, "--base", "HEAD", "--json"]);
  const r = JSON.parse(check.stdout);
  const sources = r.findings.map((f: any) => f.source.path ?? "");
  assert.ok(sources.some((p: string) => p.endsWith(mine)), "the personal learning was checked against");
  assert.ok(sources.some((p: string) => p.endsWith(name)), "and so was the committed one");

  const queued = outboxText(s.trailHome);
  assert.ok(!queued.includes("skpersonal999"), "queued its name");
  const e = JSON.parse(queued.trim());
  assert.equal(e.kind, "check");
  assert.deepEqual(e.shown_paths, [name]);

  await inHome(s.trailHome, async () => {
    await syncRepo(s.d, s.cloud, { fetch: false, fetchImpl: s.fetchImpl });
    assert.equal(await flushActivity(s.cloud, s.fetchImpl), 1);
  });
  for (const x of s.sent) assert.ok(!x.raw.includes("skpersonal999"), `sent its name to ${x.path}`);
});

test("only names the repo's last upload had go up, with that upload's authors; an older trail's lines and a repo never synced included", async () => {
  const s = scratch("unit", { [`.trail/learnings/${COMMITTED}`]: committedBbox });
  const other = "github.com/acme/billing";
  s.cloud.repos.push(other);
  const at = new Date().toISOString();
  const line = (repo: string, kind: string, paths: string[], authors: string[]) =>
    JSON.stringify({ repo, kind, asker: "Kumar", session: "s1", file_count: 1, shown_paths: paths, shown_authors: authors, at });
  await inHome(s.trailHome, async () => {
    await syncRepo(s.d, s.cloud, { fetch: false, fetchImpl: s.fetchImpl });
    writeFileSync(
      join(s.trailHome, "outbox.jsonl"),
      [
        line(KEY, "search", [COMMITTED, "2026-10-09-globexdraft-kumar.md"], ["Someone Else", "Kumar"]),
        // An older trail's check: names and authors each deduped, not in step.
        line(KEY, "check", ["2026-10-09-globexdraft-kumar.md", COMMITTED], ["Kumar"]),
        line(other, "search", ["2026-10-01-billing-globexdraft-kumar.md"], ["Kumar"]),
      ].join("\n") + "\n",
    );
    assert.equal(await flushActivity(s.cloud, s.fetchImpl), 3);
  });
  const req = s.sent.find((x) => x.path === "/api/cli/activity")!;
  assert.ok(!req.raw.includes("globexdraft"));
  assert.deepEqual(
    req.body.events.map((e: any) => [e.repo, e.kind, e.shown_paths, e.shown_authors]),
    [
      [KEY, "search", [COMMITTED], ["Priya"]],
      [KEY, "check", [COMMITTED], ["Priya"]],
      [other, "search", [], []],
    ],
  );
});

test("connecting again forgets what an earlier connection was sent: its names vouch for nothing", async () => {
  const s = scratch("reconnect", { [`.trail/learnings/${COMMITTED}`]: committedBbox });
  await inHome(s.trailHome, async () => {
    await syncRepo(s.d, s.cloud, { fetch: false, fetchImpl: s.fetchImpl });
    dropActivity();
    writeFileSync(
      join(s.trailHome, "outbox.jsonl"),
      `${JSON.stringify({ repo: KEY, kind: "search", asker: "Kumar", session: "s1", file_count: 1, shown_paths: [COMMITTED], shown_authors: ["Priya"], at: new Date().toISOString() })}\n`,
    );
    assert.equal(await flushActivity(s.cloud, s.fetchImpl), 1);
  });
  const req = s.sent.find((x) => x.path === "/api/cli/activity")!;
  assert.deepEqual(req.body.events[0].shown_paths, []);
});

test("a learning holding a secret never goes up, committed or on a pushed branch, and no use names it", async () => {
  // Synthetic, assembled at run time.
  const key = ["s", "k-proj-", "Ab3dE5fG7hJ9kL1mN3pQ5rS7tU9vW1xY3z"].join("");
  const leaky = (title: string, date: string) =>
    learning(title, "internal/ocr/bbox.go", `## Decided\nThe staging OCR account answers to ${key} for now.`, date);
  const atHead = "2026-10-08-staging-leakyhead-account-priya.md";
  const onBranch = "2026-10-09-staging-leakybranch-account-kumar.md";
  const branchOk = "2026-10-09-ocr-retry-jitter-kumar.md";
  const s = scratch("secret", { [`.trail/learnings/${COMMITTED}`]: committedBbox, [`.trail/learnings/${atHead}`]: leaky("Staging leakyhead OCR account", "2026-10-08") });
  mkdirSync(cacheDir(s.d), { recursive: true });
  writeFileSync(
    join(cacheDir(s.d), "trail-branches.json"),
    JSON.stringify({
      fetchedAt: Date.now(),
      base: "origin/main",
      branches: [
        {
          ref: "origin/kumar/staging",
          author: "Kumar",
          at: Date.now(),
          files: [],
          learnings: [
            { name: onBranch, text: leaky("Staging leakybranch OCR account", "2026-10-09") },
            { name: branchOk, text: learning("OCR retries need jitter", "internal/ocr/client.go", "## Decided\nJitter each retry.", "2026-10-09") },
          ],
        },
      ],
    }),
  );
  await inHome(s.trailHome, async () => {
    const res = await syncRepo(s.d, s.cloud, { fetch: false, fetchImpl: s.fetchImpl });
    assert.ok(!isError(res), JSON.stringify(res));
    writeFileSync(
      join(s.trailHome, "outbox.jsonl"),
      `${JSON.stringify({ repo: KEY, kind: "search", asker: "Kumar", session: "s1", file_count: 1, shown_paths: [COMMITTED, atHead, onBranch, branchOk], shown_authors: ["Priya", "Priya", "Kumar", "Kumar"], at: new Date().toISOString() })}\n`,
    );
    assert.equal(await flushActivity(s.cloud, s.fetchImpl), 1);
  });
  const up = s.sent.find((x) => x.path === "/api/cli/learnings")!;
  assert.deepEqual(up.body.learnings.map((l: any) => l.path).sort(), [`.trail/learnings/${COMMITTED}`, `.trail/learnings/${branchOk}`].sort());
  for (const x of s.sent) {
    assert.ok(!x.raw.includes(key), `sent the key to ${x.path}`);
    assert.doesNotMatch(x.raw, /leaky(head|branch)/, `sent a refused learning's name to ${x.path}`);
  }
  const req = s.sent.find((x) => x.path === "/api/cli/activity")!;
  assert.deepEqual(req.body.events[0].shown_paths, [COMMITTED, branchOk]);
  // Each named learning's author as uploaded (both files say Priya), never the use's own list.
  assert.deepEqual(req.body.events[0].shown_authors, ["Priya", "Priya"]);
});

test("only live learnings go up: a retired, held or replaced one never does, and no use names it", async () => {
  const s = scratch("live", {
    [`.trail/learnings/${COMMITTED}`]: committedBbox,
    ".trail/learnings/2026-10-07-old-retry-retired-priya.md": `---\ntitle: Old retry rule\nauthor: Priya\ndate: 2026-10-07\nstatus: retired\n---\n## Decided\nx\n`,
    ".trail/learnings/2026-10-07-retry-held-priya.md": `---\ntitle: Held retry rule\nauthor: Priya\ndate: 2026-10-07\nstatus: held\n---\n## Decided\nx\n`,
    ".trail/learnings/2026-10-07-keep-four-priya.md": `---\ntitle: Keep four retries\nauthor: Priya\ndate: 2026-10-07\nid: l-0a0a0a0a\n---\n## Decided\n4\n`,
    ".trail/learnings/2026-10-08-raise-to-six-priya.md": `---\ntitle: Raise to six retries\nauthor: Priya\ndate: 2026-10-08\nid: l-0b0b0b0b\nreplaces: l-0a0a0a0a\n---\n## Decided\n6\n`,
  });
  mkdirSync(cacheDir(s.d), { recursive: true });
  // A replacement on a teammate's unmerged branch goes up as itself, and hides nothing yet.
  const onBranch = "2026-10-09-retry-bbox-kumar.md";
  writeFileSync(
    join(cacheDir(s.d), "trail-branches.json"),
    JSON.stringify({
      fetchedAt: Date.now(),
      base: "origin/main",
      branches: [{ ref: "origin/kumar/bbox", author: "Kumar", at: Date.now(), files: [], learnings: [{ name: onBranch, text: `---\ntitle: Bbox redo\nauthor: Kumar\ndate: 2026-10-09\nid: l-0c0c0c0c\nreplaces: ${"l-"}${"0".repeat(8)}\n---\n## Decided\ny\n` }] }],
    }),
  );
  await inHome(s.trailHome, async () => {
    const res = await syncRepo(s.d, s.cloud, { fetch: false, fetchImpl: s.fetchImpl });
    assert.ok(!isError(res), JSON.stringify(res));
    writeFileSync(
      join(s.trailHome, "outbox.jsonl"),
      `${JSON.stringify({ repo: KEY, kind: "search", asker: "Kumar", session: "s1", file_count: 1, shown_paths: [COMMITTED, "2026-10-07-old-retry-retired-priya.md", "2026-10-07-keep-four-priya.md"], shown_authors: ["Priya", "Priya", "Priya"], at: new Date().toISOString() })}\n`,
    );
    assert.equal(await flushActivity(s.cloud, s.fetchImpl), 1);
  });
  const up = s.sent.find((x) => x.path === "/api/cli/learnings")!;
  assert.deepEqual(
    up.body.learnings.map((l: any) => l.path).sort(),
    [COMMITTED, "2026-10-08-raise-to-six-priya.md", onBranch].map((n) => `.trail/learnings/${n}`).sort(),
  );
  const req = s.sent.find((x) => x.path === "/api/cli/activity")!;
  assert.deepEqual(req.body.events[0].shown_paths, [COMMITTED], "a use never names a learning that didn't go up");
});

test("trail workspace names a learning left out for a secret, and why, instead of leaving it silently missing", async () => {
  const key = ["s", "k-proj-", "Ab3dE5fG7hJ9kL1mN3pQ5rS7tU9vW1xY3z"].join("");
  const leaky = "2026-10-08-staging-ocr-account-priya.md";
  const s = scratch("left-out", {
    [`.trail/learnings/${COMMITTED}`]: committedBbox,
    [`.trail/learnings/${leaky}`]: learning("Staging OCR account", "internal/ocr/bbox.go", `## Decided\nThe staging OCR account answers to ${key} for now.`, "2026-10-08"),
  });
  const { createServer } = await import("node:http");
  const server = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/api/cli/me")
      res.end(JSON.stringify({ user: s.cloud.user, workspace: s.cloud.workspace, repos: [{ key: KEY, name: "acme/extract", learnings: 1, added_by: "Priya" }] }));
    else {
      res.statusCode = 404;
      res.end("{}");
    }
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const port = (server.address() as { port: number }).port;
  writeCloud({ ...s.cloud, url: `http://127.0.0.1:${port}` }, { ...process.env, TRAIL_HOME: s.trailHome });
  const { spawn } = await import("node:child_process");
  const home = dirname(s.trailHome);
  const env = { ...process.env, HOME: home, USERPROFILE: home, TRAIL_HOME: s.trailHome, DO_NOT_TRACK: "1", TRAIL_NO_FETCH: "1", CLAUDECODE: undefined, TRAIL_INVOKED_AS: undefined };
  const out = await new Promise<{ code: number | null; out: string; err: string }>((done) => {
    const child = spawn(process.execPath, ["--import", "tsx", join(process.cwd(), "src", "bin", "trail.ts"), "workspace", s.d], { env });
    let o = "";
    let e = "";
    child.stdout.on("data", (b) => (o += b));
    child.stderr.on("data", (b) => (e += b));
    child.on("close", (code) => done({ code, out: o, err: e }));
  });
  server.close();
  assert.equal(out.code, 0, out.err);
  assert.match(out.out, new RegExp(`left out: ${escapeRe(leaky)}: looks like it holds a secret \\(an API key\\)`), out.out + out.err);
  assert.doesNotMatch(out.out, new RegExp(escapeRe(COMMITTED)), "only what was left out is named");
  assert.ok(!out.out.includes(key), "the secret itself is never printed");
});
