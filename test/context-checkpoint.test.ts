/**
 * The concept phase must be resumable across runs: a build interrupted partway
 * (session/rate limit, crash) has to pick up where it left off, not re-summarize
 * files it already did. That rests on the phase-1 summary cache being flushed to
 * disk *during* the pass, not only at the end.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildContext } from "../src/context/build.js";
import { BracketSynthesizer, PassthroughSummarizer } from "./helpers.js";
import type { Summarizer } from "../src/ai/summarize.js";

const rmDir = (dir: string): void => rmSync(dir, { recursive: true, force: true });

const cachePath = (dir: string): string => join(dir, "graft", ".cache", "summaries.json");

function fixture(n: number): string {
  const dir = mkdtempSync(join(tmpdir(), "ctxflush-"));
  for (let i = 0; i < n; i++) {
    writeFileSync(join(dir, `f${i}.ts`), `// [[Node ${i}]]\nexport const v${i} = ${i};\n`);
  }
  return dir;
}

function diskSummaryCount(dir: string): number {
  const p = cachePath(dir);
  if (!existsSync(p)) return 0;
  const parsed = JSON.parse(readFileSync(p, "utf8")) as { summaries?: Record<string, unknown> };
  return Object.keys(parsed.summaries ?? {}).length;
}

test("phase-1 summaries flush to disk mid-run, so an interrupted build resumes", async () => {
  const dir = fixture(4);
  const prev = process.env.GRAFT_SUMMARY_CHECKPOINT_MS;
  process.env.GRAFT_SUMMARY_CHECKPOINT_MS = "0"; // flush after every file
  let calls = 0;
  let diskAtThird = -1;
  const summarizer: Summarizer = {
    async summarize(code: string): Promise<string> {
      calls++;
      // By the time the 3rd file is being summarized (concurrency 1, in order),
      // the first two must already be persisted — that is what makes a kill here
      // survivable.
      if (calls === 3) diskAtThird = diskSummaryCount(dir);
      return code;
    },
  };
  try {
    await buildContext(dir, {
      model: "fake",
      summarizer,
      synthesizer: new BracketSynthesizer(),
      concurrency: 1,
    });
    assert.equal(calls, 4);
    assert.ok(diskAtThird >= 2, `expected ≥2 summaries flushed before the 3rd file, saw ${diskAtThird}`);
  } finally {
    if (prev === undefined) delete process.env.GRAFT_SUMMARY_CHECKPOINT_MS;
    else process.env.GRAFT_SUMMARY_CHECKPOINT_MS = prev;
    rmDir(dir);
  }
});

test("a rerun re-summarizes nothing — resume is $0 for unchanged files", async () => {
  const dir = fixture(4);
  try {
    const first = await buildContext(dir, {
      model: "fake",
      summarizer: new PassthroughSummarizer(),
      synthesizer: new BracketSynthesizer(),
    });
    assert.equal(first.summarized, 4);
    assert.equal(first.cached, 0);

    let called = false;
    const summarizer: Summarizer = {
      async summarize(code: string): Promise<string> {
        called = true;
        return code;
      },
    };
    const second = await buildContext(dir, {
      model: "fake",
      summarizer,
      synthesizer: new BracketSynthesizer(),
    });
    assert.equal(called, false, "no file should be re-summarized on an unchanged rerun");
    assert.equal(second.summarized, 0);
    assert.equal(second.cached, 4);
  } finally {
    rmDir(dir);
  }
});
