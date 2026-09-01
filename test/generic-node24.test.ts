import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

test(
  "Node 24 can exercise every breadth grammar without a V8 Zone OOM",
  { skip: Number(process.versions.node.split(".")[0]) < 24 ? "V8 Turboshaft regression starts in Node 24" : false },
  () => {
    const probe = join(dirname(fileURLToPath(import.meta.url)), "generic-node24-probe.ts");
    const run = spawnSync(process.execPath, ["--import", "tsx", probe], {
      encoding: "utf8",
      timeout: 60_000,
    });
    assert.equal(
      run.status,
      0,
      `breadth grammar probe failed${run.signal ? ` with ${run.signal}` : ""}:\n${run.stdout}\n${run.stderr}`,
    );
  },
);
