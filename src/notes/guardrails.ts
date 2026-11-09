/**
 * The learning a kept guardrail writes (design 2.2): the catalog's template
 * text, never model-written. `no-timeout` is a machine fact, so it holds in
 * every repo whatever `applies` says (R49), and carries the check the
 * PreToolUse fast path enforces; `push-over-ssh` is text only and holds
 * where it was kept.
 */
import { flatLine } from "./flatten.js";
import { EVERY_REPO } from "./learning-fields.js";
import type { LearningInput } from "./every-repo.js";
import { WALLS } from "../trace/walls.js";
import type { WallClass } from "../trace/types.js";

/** YYYY-MM-DD of `d` in local time (days are local dates). */
function localDay(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/**
 * The learning a kept guardrail writes (2.2). Template text only; never model-written. Throws for a class with no
 * template. `author` is '' (the person kept it at init; the screen named it).
 */
export function guardrailLearning(cls: WallClass, applies: string, evidence: string, now: Date = new Date()): LearningInput {
  const w = WALLS.find((x) => x.cls === cls);
  const g = w?.guardrail;
  if (!w || !g) throw new Error(`guardrailLearning: ${String(cls)} has no guardrail`);
  const where = g.applies === "every repo" ? EVERY_REPO : applies;
  return {
    title: g.title,
    body: g.text,
    author: "",
    date: localDay(now),
    kind: "guardrail",
    applies: where,
    src: "error-class",
    ...(g.check ? { check: g.check, enforce: "sure-fail" as const } : {}),
    wall: cls,
    evidence: flatLine(evidence, 160),
  };
}
