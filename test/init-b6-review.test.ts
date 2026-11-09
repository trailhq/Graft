/**
 * b6 review: the relay, the handover, the screen and the init record under
 * attack. Synthetic items, sessions and lines only (made-up acme repos).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { keepItems } from "../src/init/keep.js";
import { repoPlace } from "../src/notes/home.js";
import { initRecordPath, readInitRecord, updateInitRecord } from "../src/init/init-record.js";
import { pendingAsItem } from "../src/init/handover.js";
import { relayItemLine } from "../src/init/review-screen.js";
import type { InitItem } from "../src/init/types.js";
import { compiled, guardrailCandidate, REPO_KEY, skillCandidate, withHome } from "./init-screen-fixtures.js";

function shipItem(): InitItem {
  const c = { ...compiled("ship-cli", ["npm run build", "git push origin main"]), check: "git ls-remote origin refs/heads/main", meta: { ...compiled().meta, job: "ship" } };
  const s = skillCandidate("i-5a5a5a5a5a", c as never);
  return { ...s, key: `${REPO_KEY}|job:ship`, n: 1, title: "ship-cli", description: "" };
}

test("a ship skill's handover line keeps the branches its check named, as the relay printed it (D112)", async () => {
  await withHome("ship-phrase", ({ env }) => {
    const item = shipItem();
    const printed = relayItemLine(item, "acme-cli");
    assert.match(printed, /ship acme-cli to main/);
    updateInitRecord(REPO_KEY, (r) => {
      r.pending = [{ ...item }];
      r.pendingFrom = "ir-8c21";
      r.shownAt = new Date().toISOString();
    }, env);
    const disk = readFileSync(initRecordPath(REPO_KEY, env), "utf8");
    assert.ok(!disk.includes("ls-remote") && !disk.includes("git push"), "the branch names, never the check or a step");
    const back = pendingAsItem(readInitRecord(REPO_KEY, env).pending[0]!, env);
    assert.equal(relayItemLine(back, "acme-cli"), printed);
  });
});

test("a folder link planted inside init/ is never written through: the record can't land in a checkout", async () => {
  await withHome("record-dirlink", ({ home, env }) => {
    const checkout = join(home, "acme-cli", ".trail", "learnings");
    mkdirSync(checkout, { recursive: true });
    mkdirSync(join(env.TRAIL_HOME!, "init"), { recursive: true });
    symlinkSync(checkout, join(env.TRAIL_HOME!, "init", "github.com"));
    try {
      updateInitRecord(REPO_KEY, (r) => {
        r.pendingFrom = "ir-8c21";
      }, env);
    } catch { /* refusing is fine */ }
    assert.deepEqual(readdirSync(checkout), [], "nothing written into the linked folder");
    // A record already sitting behind the link is not read as this repo's.
    writeFileSync(join(checkout, "cli.json"), JSON.stringify({ v: 2, pendingFrom: "ir-9999", pending: [] }));
    assert.equal(readInitRecord(REPO_KEY, env).pendingFrom, null);
  });
});

test("two screens kept before any session start named the first: the notice holds both, so every kept item is named once (D87, O8)", async () => {
  await withHome("notice-merge", ({ home, env }) => {
    const dir = join(home, "acme-cli");
    mkdirSync(dir, { recursive: true });
    spawnSync("git", ["init", "-q"], { cwd: dir });
    const repoKey = repoPlace(dir, env).key;
    const guard: InitItem = { ...guardrailCandidate(), n: 1, title: "no-timeout", description: "" };
    keepItems([guard], [guard], "tty", env, new Date("2026-10-17T10:00:00Z"), { dir, repoKey, runId: "ir-0001" });
    const ship = shipItem();
    const skill: InitItem = { ...skillCandidate(), applies: repoKey, key: `${repoKey}|job:release`, n: 1, title: "release-npm", description: "" };
    keepItems([skill], [skill, { ...ship, n: 2 }], "tty", env, new Date("2026-10-17T11:00:00Z"), { dir, repoKey, runId: "ir-0002" });
    const n = readInitRecord(repoKey, env).notice!;
    assert.deepEqual(n.items.map((i) => i.forget).sort(), ["no-timeout", "release-npm"]);
    assert.equal(n.shownAt, null);
    assert.match(n.run, /^ir-[0-9a-f]{4,16}$/);
  });
});
