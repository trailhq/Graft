/**
 * The job vocabulary: which short typed asks name a job Trail could keep as a
 * skill (release, ship, tests, report) or one it leaves alone (CI fixes and
 * PR sweeps take judgement; running locally has no check), and which asks
 * are status or history questions, problem reports, or too long to be a job.
 * All phrasings are made up, shaped like the ones people type.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  JOB_CLASSES, JUDGEMENT_JOBS, MAX_ASK_WORDS, OFFER_FAMILIES, PROBLEM_REPORT, STATUS_OR_HISTORY, askText, isStatusOrHistory, matchJob, promptParams, wordCount,
} from "../src/trace/jobs.js";

const job = (t: string) => matchJob(t)?.job ?? null;

test("release asks", () => {
  assert.deepEqual(matchJob("pull and publish 1.4.3"), { job: "release", words: ["publish"] });
  assert.equal(job("publish the next version of the cli"), "release");
  assert.equal(job("redo the publish"), "release");
  assert.deepEqual(matchJob("cut a release"), { job: "release", words: ["release"] });
  assert.deepEqual(matchJob("bump the version and npm publish"), { job: "release", words: ["bump", "npm", "publish"] });
  assert.equal(job("release 2.0.1 please"), "release");
  for (const t of ["publish to the website", "write the release notes", "we already released that", "is the package publishable"]) assert.equal(job(t), null, t);
});

test("ship asks", () => {
  assert.deepEqual(matchJob("can you push to beta please first"), { job: "ship", words: ["push", "beta"] });
  assert.deepEqual(matchJob("alright, can you ff to prod now"), { job: "ship", words: ["ff", "prod"] });
  assert.deepEqual(matchJob("push to beta then ff to prod"), { job: "ship", words: ["push", "beta", "ff", "prod"] });
  assert.deepEqual(matchJob("fast-forward prod"), { job: "ship", words: ["ff", "prod"] });
  assert.deepEqual(matchJob("fast forward production"), { job: "ship", words: ["ff", "prod"] });
  assert.equal(job("ship it"), "ship");
  assert.deepEqual(matchJob("deploy https://example.com/preview to staging"), { job: "ship", words: ["deploy", "staging"] });
  assert.deepEqual(matchJob("promote the build to production"), { job: "ship", words: ["promote", "prod"] });
  assert.equal(job("update prod"), "ship");
});

test("judgement jobs, local runs, reports and test runs", () => {
  assert.equal(job("fix the failing checks on pr 12"), "pr-green");
  assert.equal(job("make the ci go green"), "pr-green");
  assert.equal(job("address the review comments"), "pr-green");
  assert.equal(job("go through all the open prs and close the stale ones"), "sweep");
  assert.equal(job("close more issues"), "sweep");
  assert.deepEqual(matchJob("could you open the app locally"), { job: "run-local", words: ["open", "locally"] });
  assert.equal(job("start the local server"), "run-local");
  assert.deepEqual(matchJob("any new users today?"), { job: "report", words: ["new", "users"] });
  assert.equal(job("how many new users joined this week"), "report");
  assert.deepEqual(matchJob("run the integration tests"), { job: "tests", words: ["integration", "tests"] });
  assert.deepEqual(matchJob("run all the e2e tests"), { job: "tests", words: ["e2e", "tests"] });
  assert.equal(job("integration tests please"), "tests");
  assert.equal(job("refactor the cart total"), null);
  assert.equal(job("no em dashes please"), null, "a style correction is a preference, not a job");
});

test("status and history questions name no job, tag questions included", () => {
  for (const t of [
    "did you push to beta then ff to prod?", "is it live", "is the new version published?", "okay did the publish go through", "how did we ship the native app last time",
    "you shipped that to prod, right?", "Yes can you please ship that... right?", "check if prod is updated", "tell me what did you deploy", "so was it released",
  ]) {
    assert.equal(isStatusOrHistory(t), true, t);
    assert.equal(matchJob(t), null, t);
  }
  // More than one lead word, and tags that ask for a yes.
  for (const t of ["ok so did it publish", "and so was it released", "hey, did the deploy to prod go through", "it's live on prod, isn't it?", "beta got pushed, didn't it?", "the tests passed, didn't they?"]) {
    assert.equal(isStatusOrHistory(t), true, t);
    assert.equal(matchJob(t), null, t);
  }
  for (const t of ["push to beta", "any new users today?", "publish 1.4.3", "so push to prod", "ok and publish 1.4.3"]) assert.equal(isStatusOrHistory(t), false, t);
  assert.ok(STATUS_OR_HISTORY.flags.includes("i"));
});

test("problem reports name no job", () => {
  for (const t of ["the deploy to prod is broken", "why did the publish fail", "publish doesn't work", "beta is still failing", "the push to prod went wrong"]) {
    assert.ok(PROBLEM_REPORT.test(t.toLowerCase()), t);
    assert.equal(matchJob(t), null, t);
  }
});

test("the 25-word cap", () => {
  assert.equal(MAX_ASK_WORDS, 25);
  const ask = "publish the new version";
  assert.equal(wordCount(ask), 4);
  assert.equal(job(`${ask} ${"now ".repeat(21)}`.trim()), "release", "25 words");
  assert.equal(job(`${ask} ${"now ".repeat(22)}`.trim()), null, "26 words");
});

test("fenced code, quoted lines and very long lines are not the person's ask", () => {
  assert.equal(askText("publish 1.4.3\n```\nnpm run build && git push origin main && deploy to prod\n```"), "publish 1.4.3");
  assert.equal(askText("> push to prod\nwhat does that line mean"), "what does that line mean");
  assert.equal(askText(`${"x".repeat(800)}\nrun the e2e tests`), "run the e2e tests");
  assert.equal(job("what does this log say\n```\ngit push origin beta && ff to prod\n```"), null);
  // A paste longer than the cap doesn't push a short ask over it.
  assert.equal(job(`run the integration tests\n\`\`\`\n${"word ".repeat(100)}\n\`\`\``), "tests");
});

test("promptParams: values of known shapes only", () => {
  assert.deepEqual(promptParams("publish 1.4.3"), { version: "1.4.3" });
  assert.deepEqual(promptParams("release v2.0.0-beta.1 now"), { version: "2.0.0-beta.1" });
  assert.deepEqual(promptParams("ff prod to 9c8b7a6"), { sha: "9c8b7a6" });
  assert.deepEqual(promptParams("merge #123"), { pr: "123" });
  assert.deepEqual(promptParams("check pr 45"), { pr: "45" });
  assert.deepEqual(promptParams("open localhost:3000"), { port: "3000" });
  assert.deepEqual(promptParams("run it on port 8080"), { port: "8080" });
  assert.deepEqual(promptParams("push the branch feat/cart-fix to beta"), { branch: "feat/cart-fix" });
  assert.deepEqual(promptParams("new users since 2026-10-01"), { date: "2026-10-01" });
  assert.deepEqual(promptParams("deadbeef and 1234567 are not shas"), {});
  assert.deepEqual(promptParams("push the branch to beta"), {});
});

test("the class table: judgement jobs, offer families, nouns and check words", () => {
  assert.deepEqual(JOB_CLASSES.map((c) => c.job), ["release", "ship", "pr-green", "sweep", "run-local", "report", "tests"]);
  assert.deepEqual([...JUDGEMENT_JOBS].sort(), ["pr-green", "sweep"]);
  assert.deepEqual(OFFER_FAMILIES, { release: ["npm-view"], ship: ["deploy", "ls-remote", "push"], tests: ["tests"], report: ["query"] });
  const by = Object.fromEntries(JOB_CLASSES.map((c) => [c.job, c]));
  assert.deepEqual(Object.fromEntries(JOB_CLASSES.map((c) => [c.job, c.noun])), {
    release: "release", ship: "ship", "pr-green": "CI fix", sweep: "PR sweep", "run-local": "local run", report: "report", tests: "test run",
  });
  assert.deepEqual(by.release!.checkWords, ["published", "released", "out", "live", "up"]);
  assert.deepEqual(by.ship!.checkWords, ["live", "deployed", "updated", "up", "out", "green"]);
  assert.deepEqual(by.tests!.checkWords, ["passing", "green", "pass", "passed"]);
  assert.deepEqual(by.report!.checkWords, []);
  // Every canonical word a class can report is one of its listed words.
  const canon: Record<string, string[]> = {
    release: ["publish", "release", "bump", "npm"], ship: ["push", "ff", "promote", "deploy", "ship", "merge", "update", "beta", "prod", "staging"],
    "pr-green": ["ci", "checks", "review"], sweep: ["sweep", "prs", "issues"], "run-local": ["open", "locally", "localhost"], report: ["new", "users", "signups"],
    tests: ["integration", "e2e", "tests"],
  };
  for (const c of JOB_CLASSES) assert.deepEqual([...new Set(Object.values(c.vocab))].sort(), [...canon[c.job]!].sort(), c.job);
});
