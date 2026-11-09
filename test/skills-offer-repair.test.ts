/**
 * Moment 3 (design 4.13, J06): a repair that repeats across epochs, offered
 * at Stop as a skill (compiled as moment 2 compiles it) or as a lesson whose
 * exact text line 2 shows. Real fold, real session lock, a made-up acme/shop
 * and synthetic transcripts.
 */
process.env.TZ = "UTC";
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { said } from "./trace-fixtures.js";
import { SHOP, T, add, append, bash, box, prompt, say, sayOffer, state, stop, where, kept, type Box } from "./skills-consent-fixtures.js";
import { noteWalls } from "../src/trace/wall-state.js";
import { notePoolDay } from "../src/trace/pool.js";
import { recordAnswer, recordShown } from "../src/skills/offers.js";
import { savePersonal } from "../src/skills/store.js";
import { writeLesson } from "../src/skills/lessons.js";
import { readSkillsState } from "../src/skills/state.js";
import { readLedger } from "../src/skills/ledger.js";
import { repairLines, repairLessonText, REPAIR_COPY } from "../src/skills/offer-repair.js";
import { compiled } from "./skills-store-fixtures.js";
import type { PendingOffer } from "../src/trace/types.js";

const boxes: Box[] = [];
after(() => { for (const b of boxes) rmSync(b.root, { recursive: true, force: true }); });
const mk = (opts?: Parameters<typeof box>[0]) => { const b = box(opts); boxes.push(b); return b; };

const SOCK = (b: Box) => `DOCKER_HOST=unix://${b.root}/.colima/default/docker.sock`;
const REL = "DOCKER_HOST=unix://$HOME/.colima/default/docker.sock";
/** A socket outside the test's temp home, so compile keeps the step (it refuses a temp path in a skill). */
const FIXED_SOCK = "DOCKER_HOST=unix:///home/dev/.colima/default/docker.sock";

/** An earlier epoch (another session) where go hit the Docker wall in this repo and the same env fixed it. */
function seed(b: Box, d = "2026-10-24", repo = SHOP, delta = [{ kind: "env" as const, name: "DOCKER_HOST" }]): void {
  noteWalls({ fixed: [{ cls: "docker-rootless", d, sh: "aaaaaaaaaaaa", epoch: 0, repo, program: "go", delta }] }, b.env);
}

/** The person asks for the tests; go hits the wall; (colima start;) the same tests with Colima's socket pass. */
function integration(b: Box, sec: number, opts: { enable?: boolean; reply?: string; pass?: boolean; sock?: string; args?: string } = {}): void {
  say(b, sec, "run the integration tests");
  const go = `go test${opts.args ?? ""} ./...`;
  bash(b, sec + 5, go, "Error: rootless Docker not found\nFAIL\tacme/shop\t0.1s", true);
  if (opts.enable) bash(b, sec + 10, "colima start", "INFO[0001] done");
  bash(b, sec + 20, `${opts.sock ?? SOCK(b)} ${go}`, opts.pass === false ? "FAIL\tacme/shop\t0.3s" : "ok  \tacme/shop\t0.4s", opts.pass === false);
  append(b, [said(opts.reply ?? "The integration tests pass.", where(b, sec + 30))]);
}

test("J06 as a lesson: one step compiles, so what fixed it is offered with its exact text, in every repo", () => {
  const b = mk();
  seed(b);
  integration(b, 0);
  const s = stop(b, 50);
  assert.ok(s.offer, s.why);
  const o = s.offer!;
  assert.equal(o.moment, "repaired");
  assert.equal(o.key, `${SHOP}|wall:docker-rootless|go`);
  assert.equal(o.repair!.as, "lesson");
  assert.deepEqual(o.lines, [
    'Tests pass. This is the 2nd time this week that go failed on "rootless Docker not found" and needed Colima\'s socket.',
    `Keep what fixed it as a learning, just for you in every repo: "'rootless Docker not found': ${REL}"? (yes / no)`,
  ]);
  assert.match(o.repair!.lessonSha!, /^[0-9a-f]{64}$/);
  assert.equal(o.repo, SHOP);
});

test("J06 as a skill: colima start then the tests compile to 2 steps, offered as a skill (yes / show me / no)", () => {
  const b = mk();
  seed(b, "2026-10-24", SHOP, [{ kind: "enable-step", name: "colima" }, { kind: "env", name: "DOCKER_HOST" }]);
  integration(b, 0, { enable: true, sock: FIXED_SOCK });
  const o = stop(b, 50).offer!;
  assert.ok(o, "offered");
  assert.equal(o.repair!.as, "skill");
  assert.equal(o.lines![0], 'Tests pass. This is the 2nd time this week that go failed on "rootless Docker not found" and needed colima start first and Colima\'s socket.');
  assert.equal(o.lines![1], "Keep the 2 working steps as a skill, just for you in this repo? (yes / show me / no)");
  assert.match(o.skillSha!, /^[0-9a-f]{64}$/);
});

test("the Colima-shaped step-too-long: colima start and a test step past 300 characters don't compile, so what fixed it is offered as a lesson", () => {
  const b = mk();
  seed(b, "2026-10-24", SHOP, [{ kind: "enable-step", name: "colima" }, { kind: "env", name: "DOCKER_HOST" }]);
  const args = ` -tags integration -run '${Array.from({ length: 24 }, (_, i) => `TestShop${i}`).join("|")}'`;
  integration(b, 0, { enable: true, sock: FIXED_SOCK, args });
  const o = stop(b, 50).offer!;
  assert.ok(o, "offered");
  assert.equal(o.repair!.as, "lesson");
  assert.equal(o.lines![1], `Keep what fixed it as a learning, just for you in every repo: "'rootless Docker not found': colima start, then DOCKER_HOST=unix:///home/dev/.colima/default/docker.sock"? (yes / no)`);
});

test("in {days} days when the first time was more than a week ago", () => {
  const b = mk();
  seed(b, "2026-10-07");
  integration(b, 0);
  assert.match(stop(b, 50).offer!.lines![0], /This is the 2nd time in 21 days that go failed/);
});

test("not due: no earlier epoch, one older than 45 days, one in another repo", () => {
  for (const [name, fn] of [
    ["no earlier epoch", () => {}],
    ["older than 45 days", (b: Box) => seed(b, "2026-09-01")],
    ["another repo", (b: Box) => seed(b, "2026-10-24", "github.com/acme/webshop")],
  ] as Array<[string, (b: Box) => void]>) {
    const b = mk();
    fn(b);
    integration(b, 0);
    const s = stop(b, 50);
    assert.equal(s.offer, null, name);
    assert.equal(s.why, "not-repeated", `${name}: falls through to moment 2, whose pool has no earlier day either`);
  }
});

test("not due: no checked success, or a turn ending in a question", () => {
  const b1 = mk();
  seed(b1);
  integration(b1, 0, { pass: false });
  assert.equal(stop(b1, 50).offer, null);
  const b2 = mk();
  seed(b2);
  integration(b2, 0, { reply: "The tests pass. Want me to push this to beta?" });
  assert.equal(stop(b2, 50).offer, null);
});

test("not due: a kept skill covers the job, or a kept lesson for this wall already applies here", () => {
  const b1 = mk();
  seed(b1);
  savePersonal(compiled("integration-tests", { job: "tests", applies: SHOP }), { from: "asked", runId: "r-x", consent: "asked", stepsVerified: 2, env: b1.env, now: T(0) });
  integration(b1, 0);
  assert.equal(stop(b1, 50).offer, null);
  const b2 = mk();
  seed(b2);
  writeLesson({ id: "", skill: null, at: "2026-10-20", text: `"rootless Docker not found": ${REL}`, kind: "lesson", src: "repair", wall: "docker-rootless" }, SHOP, b2.env);
  integration(b2, 0);
  assert.equal(stop(b2, 50).offer, null);
});

test("the governor: with fewer than 1 in 3 of the last 9 kept, moment 3 needs two earlier epochs", () => {
  const b = mk();
  for (let i = 0; i < 4; i++) {
    const o: PendingOffer = { offerId: `o-00010${i}`, moment: "repeated", runId: `r-g${i}`, name: "x", key: `${SHOP}|job:j${i}`, lines: ["a", "b"], channel: "stop", shownAt: null, showMe: false, yes: null, typedAfter: [] };
    recordShown(o, `github.com/acme/r${i}`, b.env, new Date(T(0).getTime() - (20 + i) * 86_400_000));
    recordAnswer(o, `github.com/acme/r${i}`, "no", b.env, new Date(T(0).getTime() - (20 + i) * 86_400_000 + 1000));
  }
  seed(b);
  integration(b, 0);
  assert.equal(stop(b, 50).offer, null, "one earlier epoch is not enough under the governor");
  const b2 = mk();
  for (const f of ["2026-10-20", "2026-10-24"]) noteWalls({ fixed: [{ cls: "docker-rootless", d: f, sh: f === "2026-10-20" ? "bbbbbbbbbbbb" : "aaaaaaaaaaaa", epoch: 0, repo: SHOP, program: "go", delta: [{ kind: "env", name: "DOCKER_HOST" }] }] }, b2.env);
  for (let i = 0; i < 4; i++) {
    const o: PendingOffer = { offerId: `o-00020${i}`, moment: "repeated", runId: `r-h${i}`, name: "x", key: `${SHOP}|job:j${i}`, lines: ["a", "b"], channel: "stop", shownAt: null, showMe: false, yes: null, typedAfter: [] };
    recordShown(o, `github.com/acme/r${i}`, b2.env, new Date(T(0).getTime() - (20 + i) * 86_400_000));
    recordAnswer(o, `github.com/acme/r${i}`, "no", b2.env, new Date(T(0).getTime() - (20 + i) * 86_400_000 + 1000));
  }
  integration(b2, 0);
  assert.match(stop(b2, 50).offer!.lines![0], /the 3rd time/);
});

test("repairLines: this repo for git-https-auth, every repo for a machine wall; the lesson's text in line 2", () => {
  const delta = [{ kind: "enable-step" as const, name: "git", text: "git remote set-url origin git@github.com:acme/shop.git", callId: "t1" }];
  const text = repairLessonText("git-https-auth", delta)!;
  assert.equal(text, "the HTTPS push asking for a username: git remote set-url origin git@github.com:acme/shop.git");
  const [l1, l2] = repairLines({ checkLine: "Shipped: main moved on origin.", nth: 3, days: 12, cls: "git-https-auth", delta, program: "git", as: "lesson", steps: 1, lessonText: text, where: "this repo" });
  // fix-lab5: line 1 names what the step does (its program and subcommand), not its raw text; line 2 shows the text.
  assert.equal(l1, "Shipped: main moved on origin. This is the 3rd time in 12 days that git failed on the HTTPS push asking for a username and needed git remote set-url first.");
  assert.equal(l2, `Keep what fixed it as a learning, just for you in this repo: "${text}"? (yes / no)`);
  // The lab's real Colima step: a status check with its fallback start, output joined. Line 1 says what it does.
  const colima = [{ kind: "enable-step" as const, name: "colima", text: "colima status 2>&1 || colima start", callId: "t2" }, { kind: "env" as const, name: "DOCKER_HOST", text: "DOCKER_HOST=unix://$HOME/.colima/default/docker.sock", callId: "t3" }];
  const [c1] = repairLines({ checkLine: "Tests pass.", nth: 2, days: 2, cls: "docker-rootless", delta: colima, program: "go", as: "skill", steps: 2, lessonText: null, where: "every repo" });
  assert.equal(c1, 'Tests pass. This is the 2nd time this week that go failed on "rootless Docker not found" and needed colima start first and Colima\'s socket.');
  for (const [text, words] of [["sudo -n colima start --cpu 4 >/dev/null", "colima start"], ["(cd infra && make up)", "make up"], ["open -a Docker", "open"], ["./scripts/dev-db.sh start 2>&1 | tail -3", "./scripts/dev-db.sh start"]] as const) {
    const [l] = repairLines({ checkLine: "Tests pass.", nth: 2, days: 2, cls: "docker-rootless", delta: [{ kind: "enable-step", name: "x", text, callId: "t" }], program: "go", as: "skill", steps: 2, lessonText: null, where: "every repo" });
    assert.ok(l.endsWith(`needed ${words} first.`), `${text}: ${l}`);
  }
  const flags = [{ kind: "flag" as const, name: "--pool", text: "--pool=forks", callId: "t" }, { kind: "wrapper" as const, name: "noglob", text: "noglob", callId: "t" }];
  assert.match(repairLines({ checkLine: "Tests pass", nth: 2, days: 3, cls: "zsh-no-match", delta: flags, program: "rm", as: "lesson", steps: 1, lessonText: "x", where: "every repo" })[0], /needed the --pool flag and noglob in front\.$/);
});

test("a lesson past 200 characters is never cut: no offer", () => {
  assert.equal(repairLessonText("docker-rootless", [{ kind: "env", name: "DOCKER_HOST", text: `DOCKER_HOST=${"x".repeat(220)}`, callId: "t" }]), null);
});

test("a yes to a repaired skill offer saves it from: repaired, with the skillSha the gate compiles", () => {
  const b2 = mk();
  seed(b2, "2026-10-24", SHOP, [{ kind: "enable-step", name: "colima" }, { kind: "env", name: "DOCKER_HOST" }]);
  integration(b2, 0, { enable: true, sock: FIXED_SOCK });
  const o = stop(b2, 50).offer!;
  assert.equal(o.repair!.as, "skill");
  sayOffer(b2, 52, o);
  assert.equal(prompt(b2, 70, "yes").answer, "yes");
  const r = add(b2, 80, `trail skills add ${o.name} --run ${o.runId}`);
  assert.equal(r.decision, null);
  assert.equal(r.cli?.saved?.from, "repaired", JSON.stringify(r.cli));
  assert.deepEqual(kept(b2).skills, [o.name]);
  const st = Object.values(readSkillsState(b2.env).skills).find((s) => s.name === o.name)!;
  assert.equal(st.from, "repaired");
  const saved = readLedger((st as unknown as { id?: string }).id ?? Object.keys(readSkillsState(b2.env).skills)[0]!, b2.env).find((l) => l.event === "saved") as { from: string } | undefined;
  assert.equal(saved?.from, "repaired");
});

test("REPAIR_COPY has no banned words and no em dash", () => {
  for (const t of Object.values(REPAIR_COPY)) assert.doesNotMatch(t, /\bmemory\b|\bremember\b|\bnotes?\b|\brules?\b|\bworkflows?\b|—/i, t);
});

test("moment 3 comes before moment 2: a job due for both gets the repair offer, one offer only", () => {
  const pool = (b: Box) => {
    for (const [i, d] of ["2026-10-20", "2026-10-23", "2026-10-27"].entries()) notePoolDay(SHOP, { job: "tests", words: ["integration", "tests"] }, { d, s: `seed${i}`, costly: true }, null, b.env, T(0));
  };
  const only2 = mk();
  pool(only2);
  integration(only2, 0, { enable: true, sock: FIXED_SOCK });
  const s2 = stop(only2, 50);
  assert.equal(s2.offer?.moment, "repeated", `without the earlier repair, moment 2 is due: ${s2.why}`);
  const both = mk();
  pool(both);
  seed(both, "2026-10-24", SHOP, [{ kind: "enable-step", name: "colima" }, { kind: "env", name: "DOCKER_HOST" }]);
  integration(both, 0, { enable: true, sock: FIXED_SOCK });
  assert.equal(stop(both, 50).offer?.moment, "repaired");
  assert.equal(state(both).pendingOffer?.moment, "repaired");
});
