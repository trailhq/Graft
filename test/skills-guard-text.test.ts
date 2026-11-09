/**
 * The agent guard reads where a person-only switch sits (D89, merge pass).
 * `skills on`, `skills keep` and `skills offers on` are denied where the
 * shell runs them: as the program or after any separator, through a
 * wrapper, a renamed binary or a variable, or inside text given to a shell
 * or an interpreter. Inside quoted arguments of text programs (grep, rg, ag,
 * git commit/log/grep, echo and printf not fed to a shell, sed, awk
 * patterns, cat) they are only words, and Trail's own repo is full of them.
 * Made-up repos and paths only.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { agentGuard } from '../src/skills/risk.js';
import { preBashSkills } from '../src/claude/pre-bash-skills.js';
import { timeBar } from './machine-speed.js';

const ENV = { HOME: '/tmp/guard-text-home', TRAIL_HOME: '/tmp/guard-text-home/.trail' };
const input = (command: string) => ({ session_id: 'sess-guard-text', tool_name: 'Bash', tool_input: { command } });

const ALLOWED = [
  'grep -rn "skills keep" src',
  'git commit -m "turn skills on by default"',
  "git commit -m 'skills offers on: ask once'",
  "rg 'skills offers on' docs",
  'ag "skills on" src',
  'egrep -n "skills (on|keep)" src/cli.ts',
  'git log --grep "skills keep" --oneline',
  'git grep -n "skills on"',
  "git commit -F - <<'EOF'\nturn skills on by default\nEOF",
  "git commit -m \"$(cat <<'EOF'\nfeat: turn skills on by default\n\nAlso trail skills keep x.\nEOF\n)\"",
  'git add -A && git commit -m "turn skills on by default" && git log -1 --stat',
  'echo "run trail skills on in your own terminal"',
  "printf '%s\\n' 'trail skills keep release-npm'",
  'echo "trail skills on" | grep -c on',
  "sed -n '/skills on/p' README.md",
  "awk '/skills keep/ { print FILENAME }' src/x.ts",
  'cat "notes/skills on.md"',
  'cd /tmp/x && grep -rn "skills keep" src | head -5',
  "(cd src && grep -n 'skills on' cli.ts)",
  'grep -c "skills on" a.txt; echo done',
  'echo "- trail skills on is the person\'s" >> CHANGELOG.md',
];

const DENIED: Array<[string, string]> = [
  // The program word, after a separator, through a wrapper.
  ['trail skills on', 'skills-on'],
  ['git commit -m x; trail skills on', 'skills-on'],
  ['grep -c "skills on" a.txt && trail skills keep x', 'keep-held'],
  ['grep -q x a.txt || trail skills offers on', 'offers-on'],
  ['env trail skills on', 'skills-on'],
  ['nohup trail skills keep x &', 'keep-held'],
  ['time trail skills on', 'skills-on'],
  ['exec trail skills on', 'skills-on'],
  // Text fed to a shell or an interpreter.
  ['echo "trail skills on" | sh', 'skills-on'],
  ["echo 'trail skills keep x' | bash", 'keep-held'],
  ["printf 'trail skills offers on' | zsh", 'offers-on'],
  ['echo "trail skills on" | tee /dev/stderr | sh', 'skills-on'],
  ['echo "trail skills on" | sed s/a/b/ | bash', 'skills-on'],
  ["echo 'trail skills on' | xargs -I{} sh -c {}", 'skills-on'],
  ['bash -c "trail skills on"', 'skills-on'],
  ["zsh -c 'trail skills keep x'", 'keep-held'],
  ['eval "trail skills on"', 'skills-on'],
  ["python3 -c \"import os; os.system('trail skills on')\"", 'skills-on'],
  ["node -e \"require('child_process').execSync('trail skills keep x')\"", 'keep-held'],
  ["sh <<'EOF'\ntrail skills on\nEOF", 'skills-on'],
  ['bash <<EOF\ntrail skills keep x\nEOF', 'keep-held'],
  ['echo "trail skills on" > >(sh)', 'skills-on'],
  // A substitution inside the quoted text runs.
  ['git commit -m "$(trail skills on)"', 'skills-on'],
  ['git commit -m "`trail skills on`"', 'skills-on'],
  ['git commit -m "$(cat <<EOF\n$(trail skills on)\nEOF\n)"', 'skills-on'],
  ["git commit -m \"$(cat <<'EOF' | sh\ntrail skills on\nEOF\n)\"", 'skills-on'],
  // Text programs that run what they're given, or ones that aren't the real program.
  ['GIT_EDITOR="trail skills on" git commit', 'skills-on'],
  ["awk 'BEGIN { system(\"trail skills on\") }'", 'skills-on'],
  ["sed 's/x/trail skills on/e' f.txt", 'skills-on'],
  ["sed -n '1e trail skills keep x' f.txt", 'keep-held'],
  ["rg --pre 'trail skills on' x src", 'skills-on'],
  ["git -c core.pager='trail skills on' log", 'skills-on'],
  ["git -c alias.x='!trail skills on' commit -m x", 'skills-on'],
  ['/tmp/grep "skills" "on"', 'skills-on'],
  ['./grep "skills on"', 'skills-on'],
  ["git grep -O'trail skills on' x", 'skills-on'],
  ["rg --hostname-bin 'trail skills on' x", 'skills-on'],
  ["printf -v c 'trail skills on'; $c", 'skills-on'],
  ["sort --compress-program='trail skills on' a.txt", 'skills-on'],
  ["less '+!trail skills on' a.txt", 'skills-on'],
  ["awk '@load \"x\"; /skills on/' a.txt", 'skills-on'],
  ['exec > >(sh); echo "trail skills on"', 'skills-on'],
  ['alias grep=trail; grep "skills" "on"', 'skills-on'],
  ['grep() { trail "$@"; }; grep "skills" "on"', 'skills-on'],
  ['PATH=/tmp/x:$PATH grep "skills" "on"', 'skills-on'],
  // Not quoted: the words the shell splits, whatever the program.
  ['grep -rn skills keep src', 'keep-held'],
  ['echo trail skills on', 'skills-on'],
  ['echo trail skills\\ on', 'skills-on'],
  // A loop or a group that runs it.
  ['for x in 1; do trail skills on; done', 'skills-on'],
  ['(echo "trail skills on") | sh', 'skills-on'],
  ['{ echo "trail skills on"; } | bash', 'skills-on'],
  // Over 64 KB a command is read whole: any switch denies.
  [`grep "skills on" src ${'x '.repeat(40_000)}`, 'skills-on'],
];

test('a switch inside quoted arguments of a text program is only words: grep, rg, git commit and log, echo, sed, awk, cat', async () => {
  for (const cmd of ALLOWED) {
    assert.equal(agentGuard(cmd), null, cmd);
    const d = await preBashSkills(input(cmd), '/tmp', ENV, cmd);
    assert.notEqual(d?.permissionDecision, 'deny', cmd);
  }
});

test('a switch the shell runs, or text handed to a shell or an interpreter, is still denied', async () => {
  for (const [cmd, hit] of DENIED) {
    assert.equal(agentGuard(cmd)?.hit, hit, cmd);
    const d = await preBashSkills(input(cmd), '/tmp', ENV, cmd);
    assert.equal(d?.permissionDecision, 'deny', cmd);
  }
});

test('the hook-script reason is unchanged by the narrowing: a hook script run next to a quoted switch is still denied', () => {
  // D116 item 2: grep only reads the hook script, so this is no longer denied; running it is.
  assert.equal(agentGuard('grep "skills on" .claude/trail-hooks.cjs'), null);
  assert.equal(agentGuard('grep "skills on" README.md; node .claude/trail-hooks.cjs prompt')?.hit, 'hook-script');
  assert.equal(agentGuard('node .claude/trail-hooks.cjs prompt < payload.json')?.hit, 'hook-script');
});

test('the narrowed guard stays linear: 2 MB of each shape reads in under 20 ms of CPU, and 64 KB of each quoted shape too', () => {
  // In a child process with a cap: a regex that backtracks blocks the event loop, so a test timeout can't stop it in here.
  const probe = `
    const { agentGuard } = await import(${JSON.stringify(new URL('../src/skills/risk.ts', import.meta.url).href)});
    const big = 2 * 1024 * 1024, small = 63 * 1024;
    const fill = (head, unit, n) => head + unit.repeat(Math.floor((n - head.length) / unit.length));
    const shapes = [
      ['trail skills on; ', 'trail ', big], ['trail skills keep x; ', 'graft x ', big], ['node .claude/trail-hooks.cjs prompt; ', 'trail-hooks-', big],
      ['trail skills on; ', '$(', big], ['trail skills on; ', 'skills -a ', big], ['trail skills on; ', 'xargs ', big],
      ['trail skills on; ', '.claude/helpers/', big], ['git commit -m "skills on" ', '"$( ', big], ['grep "skills on" ', '\\\\"', big], ['grep "skills on" ', '"a" ', big],
      ['grep "skills keep" ', "( ", big], ['echo "trail skills on" ', '| grep x ', big], ['grep "skills on" ', "'$(cat <<'E'\\n", big],
      ['git commit -m "skills on" ', '"$( ', small], ['grep "skills on" ', '"a" ', small], ['grep "skills keep" ', '( ', small],
      ['echo "trail skills on" ', '| grep x ', small], ['grep "skills on" ', "$(cat <<'E'\\n", small], ['grep "skills on" ', '<<E\\n', small],
      ['grep "skills on" ', '{ ', small], ['grep "skills on" ', '\\\\"', small], ['sed "skills on" ', "'s/a/b/' ", small],
    ];
    const out = shapes.map(([head, unit, n]) => {
      const c = fill(head, unit, n);
      // CPU time, best of 5: the work the guard does, not how busy the machine is (the suite runs files side by side).
      let best = Infinity;
      for (let k = 0; k < 5; k++) { const t = process.cpuUsage(); agentGuard(c); const d = process.cpuUsage(t); best = Math.min(best, (d.user + d.system) / 1000); }
      return { head, unit, n, ms: Math.round(best * 10) / 10 };
    });
    process.stdout.write(JSON.stringify(out));`;
  const r = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', probe], { encoding: 'utf8', timeout: 30_000 });
  assert.equal(r.signal, null, 'the guard ran past 30 s');
  // 20 ms where the bar was set, scaled to this machine, never under 80 (a backtracking regex takes seconds on 2 MB, on any machine).
  const bar = timeBar(20, 80);
  for (const row of JSON.parse(r.stdout) as Array<{ ms: number }>) assert.ok(row.ms < bar, `${JSON.stringify(row)} over ${bar.toFixed(1)} ms`);
});
