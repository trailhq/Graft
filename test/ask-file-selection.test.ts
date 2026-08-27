import { test } from "node:test";
import assert from "node:assert/strict";
import {
  fileFirstRoundRobin,
  roundRobinQueues,
} from "../src/ask/file-selection.js";

test("file-first projection preserves file order and emits leaders before sibling spans", () => {
  const ranked = [
    { id: "A1", file: "a.ts", score: 0.95 },
    { id: "A2", file: "a.ts", score: 0.93 },
    { id: "B1", file: "b.ts", score: 0.90 },
    { id: "C1", file: "c.ts", score: 0.88 },
    { id: "A3", file: "a.ts", score: 0.85 },
    { id: "D1", file: "d.ts", score: 0.80 },
    { id: "B2", file: "b.ts", score: 0.70 },
    { id: "D2", file: "d.ts", score: 0.60 },
  ];

  const grouped = ranked.map((value) => ({ group: value.file, value }));
  const projected = fileFirstRoundRobin(grouped);

  assert.deepEqual(projected.map((value) => value.id), [
    "A1", "B1", "C1", "D1", "A2", "B2", "D2", "A3",
  ]);
  assert.deepEqual(
    [...new Set(projected.map((value) => value.file))],
    [...new Set(ranked.map((value) => value.file))],
    "the first pass keeps the baseline first-occurrence file order",
  );
  assert.equal(projected[0], ranked[0], "projection preserves candidate identity and top-1");
  assert.deepEqual(
    fileFirstRoundRobin(grouped, 3).map((value) => value.id),
    ["A1", "B1", "C1"],
    "a bounded prefix does not materialize second spans before file leaders",
  );
});

test("file-first projection treats concepts as singleton partitions", () => {
  const ranked = [
    { id: "A1", group: "file:a.ts" },
    { id: "A2", group: "file:a.ts" },
    { id: "concept", group: "concept:auth:0" },
    { id: "B1", group: "file:b.ts" },
  ];

  const projected = fileFirstRoundRobin(
    ranked.map((value) => ({ group: value.group, value })),
  );
  assert.deepEqual(projected.map((value) => value.id), ["A1", "concept", "B1", "A2"]);
});

test("pre-grouped queue projection is equivalent and stops at the requested prefix", () => {
  const queues = [
    ["alpha-1", "alpha-2", "alpha-3"],
    ["beta-1", "beta-2"],
    ["gamma-1"],
  ];
  assert.deepEqual(
    roundRobinQueues(queues),
    ["alpha-1", "beta-1", "gamma-1", "alpha-2", "beta-2", "alpha-3"],
  );
  assert.deepEqual(
    roundRobinQueues(queues, 4),
    ["alpha-1", "beta-1", "gamma-1", "alpha-2"],
  );
  assert.deepEqual(roundRobinQueues(queues, 0), []);
});
