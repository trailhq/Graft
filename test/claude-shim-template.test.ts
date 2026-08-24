import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { statuslineShim, hooksShim } from '../src/claude/shim-template.js';

const BAKED = '/opt/graft/dist/claude';

for (const [name, src] of [['statusline', statuslineShim(BAKED)], ['hooks', hooksShim(BAKED)]] as const) {
  test(`${name} shim parses and knows all four candidates (baked, node_modules, lib, npm root -g)`, () => {
    const body = src.replace(/^#!.*\n/, ''); // strip shebang for vm
    assert.doesNotThrow(() => new vm.Script(body), 'valid JS');

    // 1. baked dir is present as the first candidate
    assert.match(src, new RegExp(`const BAKED = "${BAKED}"`));
    // 2. repo node_modules via require.resolve from the project dir
    assert.match(src, /require\.resolve\('@nanonets\/graft\/package\.json', \{ paths: \[base\] \}\)/);
    assert.match(src, /fromPkg\(dir\)/);
    // 3. legacy execPath/../lib guess retained
    assert.match(src, /path\.join\(path\.dirname\(process\.execPath\), '\.\.', 'lib'\)/);
    // 4. npm root -g catch-all, queried on demand (no on-disk cache)
    assert.match(src, /execFileSync\('npm', \['root', '-g'\]/);
    assert.doesNotMatch(src, /tmpdir/); // no predictable temp cache path

    // Highest version is tried first among the candidates, not first-hit — otherwise
    // the baked path pins the user to whatever graft wired the repo, forever.
    // Load failure then walks the rest. Behaviour is in claude-shim-resolve.test.ts.
    assert.match(src, /function ranked\(dirs, name\)/);
    assert.match(src, /'package\.json'/); // versionOf reads each candidate's version
    assert.match(src, /typeof mod\.main !== 'function'/);
    assert.match(src, /return true; \/\/ main\(\) was reached/);

    // Windows-safe dynamic import + best-effort catch
    assert.match(src, /pathToFileURL\(f\)/);
    assert.match(src, /\.catch\(\(\) => \{/);
  });
}

test('statusline calls main(); hooks passes the event arg', () => {
  assert.match(statuslineShim(BAKED), /m\.main\(\)/);
  assert.match(hooksShim(BAKED), /m\.main\(process\.argv\[2\]\)/);
});
