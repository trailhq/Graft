/**
 * The words rule for phase 2 (design 0 rule 6, c0): every string a person or
 * an agent reads says learnings, always follow or skills, never notes,
 * rules, memory, remember or workflows, and has no em dash. The 1a words test already reads every file in src/skills (so the new
 * offer, fold, version and value-line files count as they land) and 1b's test
 * reads ANCHOR_COPY by value (so c4's additions count). This one adds:
 *
 * - phase 2's files outside those scopes (the Codex trace, the dialect, the
 *   Codex hooks and trust reader), read as strings when each exists;
 * - phase 2's copy constants by value. Each group adds its constant to the
 *   module named below; until a module exists its entry is pending, and once
 *   it exists the constant must be there, non-empty, and clean. A GitHub
 *   Actions folder is never named by its path in copy (P22): the banned word
 *   catches it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const ROOT = process.cwd();
const BANNED = /\b(?:notes?|rules?|memory|memories|remember\w*|workflows?)\b/i;
const EM_DASH = /—/;
const offends = (t: string) => EM_DASH.test(t) || BANNED.test(t);

/** Phase 2's copy constants (design 0 rule 6) and where each group puts its own. */
const PHASE2_COPY: ReadonlyArray<{ name: string; file: string; group: string; keys?: string[] }> = [
  { name: "UPDATE_COPY", file: "src/skills/offer-words-2.ts", group: "c3" },
  { name: "DRIFT_COPY", file: "src/skills/offer-words-2.ts", group: "c3" },
  { name: "RETIRE_COPY", file: "src/skills/offer-words-2.ts", group: "c3" },
  { name: "VALUE_COPY", file: "src/skills/value-line.ts", group: "c5" },
  { name: "CODEX_COPY", file: "src/hosts/codex-trust.ts", group: "c7", keys: ["trust", "sandbox", "notTierA", "ephemeral"] },
  { name: "RUN_COPY", file: "src/skills/run.ts", group: "c10" },
];

/** Phase 2 files outside the 1a scope (src/skills, the skills hooks) and the 1b scope. */
const PHASE2_FILES = ["src/trace/codex.ts", "src/trace/dialect.ts", "src/hosts/codex-trust.ts", "src/hosts/codex-hooks.ts"];

/** Every string and template literal in `source` that is not a module path or a type (the 1a and 1b tests' scanner). */
function stringsOf(file: string, source: string): Array<{ line: number; text: string }> {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const out: Array<{ line: number; text: string }> = [];
  const visit = (n: ts.Node): void => {
    let text: string | null = null;
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) text = n.text;
    else if (ts.isTemplateExpression(n)) text = [n.head.text, ...n.templateSpans.map((s) => s.literal.text)].join("{}");
    const p = n.parent;
    const skip = p && (ts.isImportDeclaration(p) || ts.isExportDeclaration(p) || ts.isLiteralTypeNode(p) || ts.isExternalModuleReference(p)
      || (ts.isCallExpression(p) && p.expression.kind === ts.SyntaxKind.ImportKeyword));
    if (text !== null && !skip) out.push({ line: sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1, text });
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

/** Every string in a copy value: a string, or the strings of an object or array of them, with their paths. */
function texts(v: unknown, at: string): Array<[string, string]> {
  if (typeof v === "string") return [[at, v]];
  if (typeof v === "function") return [];
  if (Array.isArray(v)) return v.flatMap((x, i) => texts(x, `${at}[${i}]`));
  if (v && typeof v === "object") return Object.entries(v).flatMap(([k, x]) => texts(x, `${at}.${k}`));
  return [];
}

test("the list names each phase 2 copy constant once, in a file its group owns", () => {
  assert.deepEqual(PHASE2_COPY.map((c) => c.name), ["UPDATE_COPY", "DRIFT_COPY", "RETIRE_COPY", "VALUE_COPY", "CODEX_COPY", "RUN_COPY"]);
  assert.equal(new Set(PHASE2_COPY.map((c) => c.name)).size, PHASE2_COPY.length);
});

test("each phase 2 copy constant whose module has landed is there, non-empty, with no banned word or em dash", async () => {
  const bad: string[] = [];
  for (const c of PHASE2_COPY) {
    const path = join(ROOT, c.file);
    if (!existsSync(path)) continue; // pending: its group hasn't landed yet
    const mod = (await import(pathToFileURL(path).href)) as Record<string, unknown>;
    assert.ok(Object.hasOwn(mod, c.name), `${c.file} exports ${c.name} (${c.group})`);
    const all = texts(mod[c.name], c.name);
    assert.ok(all.length > 0, `${c.name} has words`);
    if (c.keys) assert.deepEqual(Object.keys(mod[c.name] as object).sort(), [...c.keys].sort(), c.name);
    for (const [at, t] of all) if (offends(t)) bad.push(`${at}: ${t.slice(0, 120)}`);
  }
  assert.deepEqual(bad, []);
});

test("no string in phase 2's files outside the skills scope has an em dash or a banned word", () => {
  const bad: string[] = [];
  for (const file of PHASE2_FILES) {
    const path = join(ROOT, file);
    if (!existsSync(path)) continue;
    for (const s of stringsOf(file, readFileSync(path, "utf8"))) if (offends(s.text)) bad.push(`${file}:${s.line} ${JSON.stringify(s.text.slice(0, 120))}`);
  }
  assert.deepEqual(bad, []);
});

test("the by-value check catches a banned word and the Actions folder's path", () => {
  const caught = texts({ a: "Trail keeps your notes", b: ["fine", "see .github/workflows/release.yml"], c: () => "skipped" }, "X").filter(([, t]) => offends(t));
  assert.deepEqual(caught.map(([at]) => at), ["X.a", "X.b[1]"]);
});
