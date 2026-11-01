/**
 * The words rule for phase 1b (design 0 rule 7, b7): the 1a words test reads
 * src/skills/* and the skills hooks; this one adds 1b's copy outside them:
 * the wall catalog (WALL_COPY and each fix), the sure-fail deny, init's
 * screen, relay and keep words, the hooks b7 added (walls, the kept-at-start
 * notice) and the linked-folder refusal. The words are learnings (a new one
 * for what used to be a lesson), always follow and skills; never notes,
 * rules, memory, remember or workflows; no em dash (test/vocabulary-units
 * checks the old kind words stay out of the copy). The copy constants are checked by value
 * too, and anchors.ts and anchors-git.ts never start a process.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { INIT_COPY } from "../src/init/review-screen.js";
import { WALL_COPY, WALLS } from "../src/trace/walls.js";
import { REPAIR_COPY } from "../src/skills/offer-repair.js";
import { LESSON_COPY } from "../src/skills/lessons.js";
import { ANCHOR_COPY } from "../src/skills/anchors.js";
import { SURE_FAIL_REASON } from "../src/trace/guard-fast.js";
import { keptContext } from "../src/claude/start-init.js";

const ROOT = process.cwd();
const BANNED = /\b(?:notes?|rules?|memory|memories|remember\w*|workflows?)\b/i;
const EM_DASH = /—/;
const offends = (t: string) => EM_DASH.test(t) || BANNED.test(t);

/** 1b files outside the 1a scope. */
function scope(): string[] {
  const init = readdirSync(join(ROOT, "src/init")).filter((f) => f.endsWith(".ts")).map((f) => `src/init/${f}`);
  return [
    ...init, "src/trace/walls.ts", "src/trace/guard-fast.ts", "src/claude/walls-hook.ts", "src/claude/start-init.ts", "src/notes/linked-learnings.ts",
    "src/notes/every-repo.ts", "src/notes/guardrails.ts",
  ].sort();
}

/** Strings that are data, never shown, each with why. */
const EXEMPT: Array<{ file: string; starts: string; why: string }> = [
  { file: "src/init/howtos.ts", starts: "memory", why: "Claude Code's own folder name (~/.claude/projects/<key>/memory), a path part, never shown" },
  { file: "src/init/look-back-mine.ts", starts: "notes", why: "the personal folder's name on disk (repos/<key>/notes), a path part, never shown" },
];

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

test("no string in 1b's files outside the skills scope has an em dash or a banned word", () => {
  const bad: string[] = [];
  let read = 0;
  for (const file of scope()) {
    for (const s of stringsOf(file, readFileSync(join(ROOT, file), "utf8"))) {
      read++;
      if (!offends(s.text) || EXEMPT.some((e) => e.file === file && s.text === e.starts)) continue;
      bad.push(`${file}:${s.line} ${JSON.stringify(s.text.slice(0, 120))}`);
    }
  }
  assert.ok(read > 300, `read ${read} strings`);
  assert.deepEqual(bad, []);
});

test("each exemption still names a string that is there", () => {
  for (const e of EXEMPT) assert.ok(stringsOf(e.file, readFileSync(join(ROOT, e.file), "utf8")).some((s) => s.text === e.starts), `${e.file}: ${e.why}`);
});

test("1b's copy constants and every wall fix, by value: no banned word, no em dash", () => {
  const ctxs = [{ hasProgram: () => false, remoteSsh: null }, { hasProgram: () => true, remoteSsh: "git@github.com:acme/shop.git" }];
  const all: Array<[string, string]> = [
    ...Object.entries(INIT_COPY), ...Object.entries(WALL_COPY), ...Object.entries(REPAIR_COPY), ...Object.entries(LESSON_COPY), ...Object.entries(ANCHOR_COPY),
    ["SURE_FAIL_REASON", SURE_FAIL_REASON], ["keptContext", keptContext("release-npm (skill, undo: trail forget release-npm)")],
    ...WALLS.flatMap((w) => [...ctxs.map((c) => [`${w.cls} fix`, w.fix(c)] as [string, string]), [`${w.cls} words`, w.words] as [string, string],
      ...(w.guardrail ? [[`${w.cls} guardrail`, `${w.guardrail.title} ${w.guardrail.text}`] as [string, string]] : [])]),
  ];
  const bad = all.filter(([, t]) => offends(t)).map(([k, t]) => `${k}: ${t.slice(0, 120)}`);
  assert.deepEqual(bad, []);
  assert.ok(all.length > 40, String(all.length));
});

test("anchors.ts and anchors-git.ts start no process and touch no network", () => {
  for (const f of ["src/skills/anchors.ts", "src/skills/anchors-git.ts", "src/notes/linked-learnings.ts", "src/skills/cli-skills-report-1b.ts"]) {
    assert.doesNotMatch(readFileSync(join(ROOT, f), "utf8"), /child_process|node:net|node:http|node:https|node:dns|fetch\(/, f);
  }
});
