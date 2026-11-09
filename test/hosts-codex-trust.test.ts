/**
 * Phase 2 c7 (design 4.17, rule 8, HC8): the read-only check of whether Codex trusts Trail's hook entries. Codex keeps
 * a non-managed hook's trust in `config.toml` as `[hooks.state."<hooks.json path>:<event>:<group>:<handler>"]` with
 * a `trusted_hash` (the key form read from the open-source Codex, `hook_key`; HC8 confirms it on the installed
 * build). Trail only reads it: it never writes the table. A form it doesn't know is `unknown`, never a guess.
 * Temp CODEX_HOME only; nothing here reads the real one.
 */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CODEX_COPY, codexTrust, codexTrustLine, trailHookKeys } from '../src/hosts/codex-trust.js';
import { installCodexHooks } from '../src/hosts/codex-hooks.js';

const made: string[] = [];
after(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); });

function codexHome(): { env: NodeJS.ProcessEnv; home: string; cfg: string } {
  const root = mkdtempSync(join(tmpdir(), 'c7-trust-'));
  made.push(root);
  mkdirSync(join(root, '.codex'), { recursive: true });
  installCodexHooks(root);
  const home = join(root, '.codex');
  return { env: { HOME: root, CODEX_HOME: home }, home, cfg: join(home, 'config.toml') };
}

// A key quoted as Codex writes it, a TOML basic string: a Windows path's backslashes are escaped.
const q = (key: string) => JSON.stringify(key);
const section = (key: string, body: string) => `[hooks.state.${q(key)}]\n${body}\n`;
const HASH = 'trusted_hash = "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"';

test("Trail's keys are the hooks.json path, the event's Codex label and the indexes, one per Trail handler", () => {
  const { env, home } = codexHome();
  const p = join(home, 'hooks.json');
  assert.deepEqual(trailHookKeys(env), [
    `${p}:session_start:0:0`, `${p}:user_prompt_submit:0:0`, `${p}:post_tool_use:0:0`, `${p}:post_tool_use:1:0`, `${p}:pre_tool_use:0:0`, `${p}:stop:0:0`,
  ]);
  // A foreign entry in front moves Trail's index, and the key follows it.
  const cfg = JSON.parse(readFileSync(p, 'utf8'));
  cfg.hooks.Stop.unshift({ hooks: [{ type: 'command', command: 'other-tool' }] });
  writeFileSync(p, JSON.stringify(cfg));
  assert.ok(trailHookKeys(env).includes(`${p}:stop:1:0`));
});

test('no config.toml, or one with no hooks.state: untrusted, every Trail entry named', () => {
  const { env, cfg } = codexHome();
  let t = codexTrust(env);
  assert.equal(t.state, 'untrusted');
  assert.equal(t.untrusted.length, 6);
  writeFileSync(cfg, 'model = "gpt-5-codex"\n\n[features]\nhooks = true\n');
  t = codexTrust(env);
  assert.equal(t.state, 'untrusted');
  assert.equal(t.untrusted.length, 6);
});

test('a trust record for each Trail entry: trusted; one missing or turned off: untrusted, naming it', () => {
  const { env, cfg } = codexHome();
  const keys = trailHookKeys(env);
  writeFileSync(cfg, `model = "gpt-5-codex"\n\n${keys.map((k) => section(k, HASH)).join('\n')}`);
  assert.deepEqual(codexTrust(env), { state: 'trusted', untrusted: [] });
  assert.equal(codexTrustLine(env), null);
  writeFileSync(cfg, keys.slice(1).map((k) => section(k, HASH)).join('\n'));
  assert.deepEqual(codexTrust(env), { state: 'untrusted', untrusted: [keys[0]] });
  writeFileSync(cfg, keys.map((k, i) => section(k, i === 2 ? `${HASH}\nenabled = false` : HASH)).join('\n'));
  assert.deepEqual(codexTrust(env), { state: 'untrusted', untrusted: [keys[2]] });
  // A record with no hash is no trust.
  writeFileSync(cfg, keys.map((k, i) => section(k, i === 4 ? 'enabled = true' : HASH)).join('\n'));
  assert.deepEqual(codexTrust(env), { state: 'untrusted', untrusted: [keys[4]] });
});

test('the inline form under [hooks.state] reads the same', () => {
  const { env, cfg } = codexHome();
  const keys = trailHookKeys(env);
  writeFileSync(cfg, `[hooks.state]\n${keys.map((k) => `${q(k)} = { ${HASH} }`).join('\n')}\n\n[features]\nhooks = true\n`);
  assert.deepEqual(codexTrust(env), { state: 'trusted', untrusted: [] });
});

test("a key form Trail doesn't know, a trust line it can't place, or no hooks.json: unknown, never a guess", () => {
  const { env, cfg, home } = codexHome();
  writeFileSync(cfg, section('graft-hooks.cjs#pre-bash', HASH));
  assert.equal(codexTrust(env).state, 'unknown');
  writeFileSync(cfg, `[hooks]\nstate."x".trusted_hash = "sha256:00"\n`);
  assert.equal(codexTrust(env).state, 'unknown');
  writeFileSync(cfg, `${section(`${home}/hooks.json:stop:0:0`, HASH)}[hooks.state.${q(`${home}/hooks.json:pre_tool_use:0:0`)}]\ntrusted_hash = 7\n`);
  assert.equal(codexTrust(env).state, 'unknown', 'a hash that is not a string');
  rmSync(join(home, 'hooks.json'));
  assert.equal(codexTrust(env).state, 'unknown');
  assert.equal(codexTrust({ HOME: '/nowhere', CODEX_HOME: '/nowhere/.codex' }).state, 'unknown');
  assert.equal(codexTrustLine({ HOME: '/nowhere', CODEX_HOME: '/nowhere/.codex' }), null, 'no Codex here: nothing to say');
});

test('trust records for another hooks.json only: Trail\'s are still untrusted', () => {
  const { env, cfg } = codexHome();
  writeFileSync(cfg, section('/home/dev/acme/.codex/hooks.json:stop:0:0', HASH));
  assert.equal(codexTrust(env).state, 'untrusted');
});

test('the check only reads: config.toml and hooks.json are the same bytes and times after it', () => {
  const { env, cfg, home } = codexHome();
  writeFileSync(cfg, 'model = "gpt-5-codex"\n');
  const before = [readFileSync(cfg, 'utf8'), statSync(cfg).mtimeMs, readFileSync(join(home, 'hooks.json'), 'utf8'), statSync(join(home, 'hooks.json')).mtimeMs];
  codexTrust(env);
  codexTrustLine(env);
  assert.deepEqual([readFileSync(cfg, 'utf8'), statSync(cfg).mtimeMs, readFileSync(join(home, 'hooks.json'), 'utf8'), statSync(join(home, 'hooks.json')).mtimeMs], before);
});

test("the person's line names /hooks and the shim; it shows whenever trust isn't sure", () => {
  const { env } = codexHome();
  assert.equal(codexTrustLine(env), CODEX_COPY.trust);
  assert.match(CODEX_COPY.trust, /\/hooks/);
  assert.match(CODEX_COPY.trust, /graft-hooks\.cjs/);
  assert.deepEqual(Object.keys(CODEX_COPY).sort(), ['ephemeral', 'notTierA', 'sandbox', 'trust']);
  assert.ok(Object.isFrozen(CODEX_COPY));
});

test('trust records written inside a multi-line string are text, not records: untrusted, or unknown, never trusted', () => {
  const { env, cfg } = codexHome();
  const fake = trailHookKeys(env).map((k) => section(k, HASH)).join('');
  for (const q of ['"""', "'''"]) {
    writeFileSync(cfg, `model = "gpt-5"\ninstructions = ${q}\n${fake}${q}\n`);
    assert.notEqual(codexTrust(env).state, 'trusted', q);
    assert.equal(codexTrustLine(env), CODEX_COPY.trust, q);
  }
});
