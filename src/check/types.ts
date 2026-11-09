/**
 * What `trail check` reports: one finding per changed file a learning, a
 * skill or a takeaway bears on, saying whether the change goes against it or
 * follows it. Going against a learning is a `conflict`, which fails the check,
 * only when the learning is the repo's, committed on the base branch and about
 * that very file; otherwise it is a `lead`, worth a look and never a failure.
 */
export interface CheckFinding {
  file: string;
  line?: number;
  verdict: "conflict" | "lead" | "follows";
  /** A lead's reason it can't fail the check: "not about this file", "a learning just for you". */
  why?: string;
  /** A learning on this branch, not yet on the base, that replaces the one this finding cites. It counts once it's merged. */
  replacedBy?: { id: string; title: string };
  summary: string;
  source: { kind: string; title?: string; author?: string; date?: string; path?: string; quote?: string; name?: string; version?: number };
}

export interface CheckResult {
  /** Changed files checked. */
  files: number;
  /** Learnings checked against. */
  notes: number;
  /** Skills checked against. */
  skills: number;
  findings: CheckFinding[];
}
