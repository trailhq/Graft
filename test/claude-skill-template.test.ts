import { test } from 'node:test';
import assert from 'node:assert/strict';
import { skillTemplate } from '../src/claude/skill-template.js';

test('skill template is a well-formed SKILL.md', () => {
  const src = skillTemplate();
  assert.ok(src.startsWith('---\n'), 'starts with YAML frontmatter');
  assert.match(src, /^name: graft$/m, 'declares name: graft');
  assert.match(src, /^description:/m, 'has a description');
  const body = src.split(/\n---\n/)[1] ?? '';
  assert.ok(body.trim().length > 0, 'has a non-empty body');
  assert.match(body, /graft ask/, 'body tells the agent to use `graft ask`');
  assert.match(body, /every occurrence/i, 'body teaches the exhaustive-task grep rule');
  assert.match(body, /graft callers/, 'body teaches the callers command');
  assert.match(body, /--direction out/, 'body teaches callees via --direction out');
  assert.match(body, /--depth/, 'body teaches blast radius via --depth');
  assert.match(body, /truncated/i, 'body tells the agent to follow up on truncated spans');
  assert.match(body, /graft grep/, 'body routes sweeps to graft grep');
  assert.match(body, /graft map/, 'body tells the agent to orient with graft map before exploring');
  assert.match(body, /\[scope\/\]/, 'body teaches the [scope/] label on multi-scope hits');
  assert.match(body, /--in <scope>\//, 'body teaches narrowing with ask --in <scope>/');
  assert.match(body, /tokens saved/i, 'body references the tokens-saved footer');
  assert.match(body, /every turn/i, 'body tells the agent to report savings each turn');
});

// Design 1.7, as D101 reworded it: what the agent must and must not do with learned skills, words exactly. No line tells
// the agent to skip asking the person, and none orders it to recite.
const SKILL_INTRO = [
  "Trail keeps commands that worked here as skills, just for the person, and keeps",
  "one only after the person says yes. When they ask for that job again, it brings",
  "the steps back.",
];
const SKILL_LINES = [
  "- Trail may ask you to run `trail skills add <name> --run <id>`, only after the person typed yes to its offer or asked to save a job; its message quotes what they typed. Never run it on your own.",
  "- When Trail offers to keep a job, it gives you 2 lines to end your reply with, so the person can answer; Trail reads their answer to the last one, so keep it as it is.",
  // 1b (design 1.7): two lines; the second says "keep its lines as they are", not "word for word" (D101: no line orders a recital).
  "- When `trail init` gives you a list, show it as written and run `trail keep` only with the numbers the person typed.",
  "- When Trail offers a learning, keep its lines as they are; run `trail skills lesson` only after the person typed yes.",
  // Phase 2 (1.8): the one line on trail skills update.
  "- Trail may ask you to run `trail skills update <name> --offer <id>` only after the person typed yes to the change it showed.",
  "- Never write or edit a skill's steps yourself. Never run `trail skills keep`, `trail skills on` or `trail skills offers on`: those are the person's.",
  "- When a run block comes in, start from its steps, in order.",
  "- Claude Code asks the person before a step marked \"can't be undone\"; wait for that. If they say no, don't retry it that turn; ask them to run it themselves. Where the run block says this session can't ask, don't run that step, not even after a yes in chat: show the person the command.",
  "- End a run from a skill with \"Used skill <name>\".",
];

test("the trail skill carries the nine learned-skills lines, word for word, each on one line, under a Skills heading", () => {
  const trail = skillTemplate("trail");
  const lines = trail.split("\n");
  for (const l of SKILL_LINES) assert.ok(lines.includes(l), `missing: ${l}`);
  const at = lines.indexOf("## Skills");
  assert.ok(at > 0, "a Skills section");
  assert.deepEqual(lines.slice(at + 1, at + 1 + SKILL_INTRO.length), SKILL_INTRO, "the two plain lines on what Trail keeps come first");
  assert.doesNotMatch(trail, /don't ask in chat|word for word in at most|covers (?:both|all)/i);
  assert.deepEqual(lines.slice(at + 1, at + 4 + SKILL_LINES.length).filter((l) => l.startsWith("- ")), SKILL_LINES);
  assert.doesNotMatch(trail, /—/);
  assert.doesNotMatch(skillTemplate("graft"), /trail skills add/, "graft's skill is unchanged");
});

test("the skill asks for a plain headline a teammate understands and puts the files in the body", () => {
  const src = skillTemplate("trail").replace(/\s+/g, ' ');
  assert.equal(src.split('--title "<the decision in plain words a teammate understands, no file names>"').length - 1, 2, "both save lines ask for the plain headline");
  assert.match(src, /Put files, commands and values in the body under "In the code:"\./);
  assert.doesNotMatch(src, /the fact, not the task/);
});
