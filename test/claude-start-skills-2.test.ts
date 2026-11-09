/**
 * Phase 2 c8 at SessionStart and in the agent's first words: SKILLS_INTRO names every command a Trail directive
 * asks the agent to run (a walk over the directives each moment gives), the skill template's line on
 * `trail skills update`, Codex's tier B and ephemeral lines (D137) said once in the intro, and the rollout's
 * first line kept in `st.codex.meta`. Made-up repo and offers only.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { at, box, done, hook, one, stateOf } from './claude-skills-journey-fixtures.js';
import { cxSession, cxStart } from './codex-journey-fixtures.js';
import { SKILLS_INTRO } from '../src/claude/start-skills.js';
import { answerDirective, stopBlockReason, postToolOfferText } from '../src/skills/offers.js';
import { answer2 } from '../src/skills/offer-words-2.js';
import { CODEX_COPY } from '../src/hosts/codex-trust.js';
import { SKILL_TEMPLATE_UPDATE_LINE, skillTemplate } from '../src/claude/skill-template.js';
import type { PendingOffer } from '../src/trace/types.js';

const ctxOf = (out: Record<string, any> | null): string => out?.hookSpecificOutput?.additionalContext ?? '';
const base = (o: Partial<PendingOffer>): PendingOffer => ({
  offerId: 'o-1a2b3c', moment: 'repeated', runId: 'r-1027-0001', name: 'release-npm', key: 'github.com/acme/shop|job:release',
  lines: ['Published 1.4.4: npm shows it.', 'Keep it as a skill? (yes / show me / no)'], channel: 'stop', shownAt: '2026-10-27T12:00:00.000Z',
  showMe: false, yes: null, typedAfter: [], repo: 'github.com/acme/shop', ...o,
} as PendingOffer);
const fold = (op: 'update' | 'extend' | 'split' | 'replace') => ({ op, skillId: 's-7f3a2c', baseHash: 'sha256:00', proposalSha: '0'.repeat(16), handEdited: false, version: 1, ...(op === 'split' ? { splitName: 'release-npm' } : {}) });

/** Every directive and block a moment gives, as the agent reads it. */
function directives(): string[] {
  const env = { HOME: '/home/dev', TRAIL_HOME: '/home/dev/.trail' };
  const plain = { paused: false, firstNo: false };
  const offers: PendingOffer[] = [
    base({}),
    base({ moment: 'repaired', lines: ['That fixed it.', 'Keep it as a lesson for npm publish? (yes / no)'], repair: { as: 'lesson', cls: 'npm-auth', delta: [], lessonSha: 'x' } as never }),
    base({ moment: 'update', key: 's-7f3a2c|update|v1', lines: ['Released.', 'Change step 5 of release-npm to the command that worked? 1 line changes. (yes / show me / no)'], fold: fold('update') }),
    base({ moment: 'update', key: 's-7f3a2c|update|v1', lines: ['Released.', 'Keep steps 1 to 3 as their own skill, release-npm, beside release-npm? (yes / show me / no)'], fold: fold('split') }),
    base({ moment: 'drift', key: 's-7f3a2c|drift|v1', lines: ['Released.', 'Replace release-npm with the 4 steps that just worked, retire it, or leave it? (replace / retire / leave it)'], fold: fold('replace'), retire: { skillId: 's-7f3a2c', name: 'release-npm' } }),
    base({ moment: 'retire', key: 's-7f3a2c|retire', lines: ['Trail brought in skill release-npm 5 times lately, and its steps ran in 1 of them.', 'Retire it? trail skills restore release-npm brings it back. (retire / keep it)'], retire: { skillId: 's-7f3a2c', name: 'release-npm' } }),
  ];
  const out: string[] = [];
  for (const o of offers) {
    out.push(stopBlockReason(o), postToolOfferText(o));
    for (const a of ['yes', 'show'] as const) {
      const isPhase2 = o.moment === 'update' || o.moment === 'drift' || o.moment === 'retire';
      out.push(String((isPhase2 ? answer2(a, o, plain, env, 'yes') : answerDirective(a, o, plain, env, 'yes')).context ?? ''));
    }
  }
  // init's list asks for trail keep (its words, read from the source: they need an init record to be said).
  out.push(readFileSync(new URL('../src/init/review-screen.ts', import.meta.url), 'utf8'));
  return out;
}

const runHeads = (t: string) => [...t.matchAll(/\b[Rr]un:? (trail (?:skills )?[a-z]+)\b/g)].map((m) => m[1]!);

test('SKILLS_INTRO names every command a directive asks the agent to run, update and draft --print included', () => {
  const intro = SKILLS_INTRO.join('\n');
  const heads = new Set(directives().flatMap(runHeads));
  for (const h of ['trail skills add', 'trail skills lesson', 'trail skills update', 'trail skills draft', 'trail keep']) assert.ok(heads.has(h), `a directive names ${h}`);
  for (const h of heads) assert.ok(intro.includes(h), `the intro names ${h}`);
  assert.match(intro, /trail skills update <name> --offer <id>/);
  assert.match(intro, /restore <name> --version <n>/, 'the person-only restore by version');
});

test('the skill template says trail skills update runs only after the person typed yes to the change shown', () => {
  assert.equal(SKILL_TEMPLATE_UPDATE_LINE, 'Trail may ask you to run `trail skills update <name> --offer <id>` only after the person typed yes to the change it showed.');
  assert.ok(skillTemplate('trail').includes(`- ${SKILL_TEMPLATE_UPDATE_LINE}\n`));
  assert.ok(!skillTemplate('graft').includes(SKILL_TEMPLATE_UPDATE_LINE), "graft's skill is unchanged");
});

test('Codex tier B: the intro says once that Trail keeps nothing new there yet; a compaction says nothing of it again (D137)', async () => {
  const b = box('c8-start-b');
  try {
    const s = cxSession(b);
    const start = ctxOf(one(await cxStart(s, at(20, 0))));
    assert.equal(start.split(CODEX_COPY.notTierA).length - 1, 1, start);
    assert.equal(stateOf(s).codex?.meta?.id, s.sid, 'the rollout\'s first line kept in st.codex.meta');
    assert.equal(stateOf(s).codex?.meta?.originator, 'codex_cli_rs');
    assert.ok(!ctxOf(one(await cxStart(s, at(20, 60), 'compact'))).includes(CODEX_COPY.notTierA));
  } finally {
    done(b);
  }
});

test('Codex tier A says nothing of tier B; an ephemeral Codex session (no rollout) says it keeps nothing new from it', async () => {
  const b = box('c8-start-a', { env: { TRAIL_TIER_CODEX: 'A' } });
  try {
    const s = cxSession(b);
    const start = ctxOf(one(await cxStart(s, at(20, 0))));
    assert.ok(!start.includes(CODEX_COPY.notTierA));
    assert.ok(!start.includes(CODEX_COPY.ephemeral));
    // A SessionStart payload with a turn_id and no rollout: ephemeral (learning and the fold off, recall only).
    const e = cxSession(b, { payload: { transcript_path: null } });
    const ep = ctxOf(one(await hook(e, 'session-start', { hook_event_name: 'SessionStart', source: 'startup' }, at(20, 5))));
    assert.equal(ep.split(CODEX_COPY.ephemeral).length - 1, 1, ep);
    assert.ok(!ep.includes(CODEX_COPY.notTierA));
  } finally {
    done(b);
  }
});
