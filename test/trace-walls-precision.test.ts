/**
 * D147: the wall labels (166 real matches, two independent labellers) put
 * zsh-no-match at 51/103 and docker-rootless at 8/9. This pins the fix as a
 * replay on synthetic look-alikes of those rows' shapes (no real command or
 * output is copied here; the quoted-output rule is in trace-walls-quoted):
 *   - zsh-no-match fires only when the glob zsh names is a flag value
 *     (`--include=*.ts`), a URL or `?key=` query argument, a pathspec or
 *     `ref:path` given to git grep, log or diff, or a grep/rg pattern; a glob
 *     that is a filesystem path given to a file-handling command (ls, rm, cp,
 *     mv, du, wc, cat, a for-in list, ...) is no hit.
 * The exit-0 rule (P23, D140) and the 1b safeguards stay as they were.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { matchWall } from "../src/trace/walls.js";

const Z = (word: string, n = 1) => `(eval):${n}: no matches found: ${word}`;
const S = "/tmp/claude-501/-Users-dev/0f3c/scratchpad";

/** [why, command, result, failed]: the right shapes, which must still fire. */
const ZSH_RIGHT: Array<[string, string, string, boolean]> = [
  ["grep --include in a pipe", 'grep -rl --include=*.js "SOME_SIGNAL" .next/ 2>/dev/null | while read f; do echo "$f"; done', Z("--include=*.js"), false],
  ["grep --include after the paths", "grep -rn 'minScore' workflows/ src/lib --include=*.ts -l; echo ---", `${Z("--include=*.ts")}\n---`, true],
  ["grep --include behind cd and a heredoc", `cd /home/dev/shop && python3 - <<'EOF'\nopen('a.txt','w').write('x')\nEOF\ngrep -rn "foo" src --include=*.ts`, `1\n${Z("--include=*.ts", 4)}`, false],
  ["rg --glob value", "rg -n handler --glob=*.go internal", Z("--glob=*.go"), true],
  ["grep --include as a separate word", "grep -rn token --include *.md docs", Z("*.md"), true],
  ["find -name value", "find . -name *.snap -delete", Z("*.snap"), true],
  ["gh api with a ?query", "gh api orgs/acme/repos?per_page=100 --jq '.[].name' 2>&1 | sort | head; echo --; git clone -q git@github.com:acme/shop.git /tmp/shop", `${Z("orgs/acme/repos?per_page=100")}\n--`, false],
  ["gh api with ?ref=", "gh api repos/acme/shop/contents/.github/x.yml?ref=v1.2.0 --jq .sha 2>&1", Z("repos/acme/shop/contents/.github/x.yml?ref=v1.2.0"), true],
  ["curl of a URL with a query", "curl -s https://api.example.test/v1/items?limit=5", Z("https://api.example.test/v1/items?limit=5"), true],
  ["git grep pathspec after --", 'cd /home/dev/shop && git grep -n -E "patch|diff" origin/main -- src/brain/push*.ts src/brain/local-push*.ts 2>/dev/null | head', Z("src/brain/push*.ts"), false],
  ["git grep pathspec through a variable", `R=/home/dev/shop; git -C $R grep -n limit origin/dev -- $R/backend/services/memory*`, Z("/home/dev/shop/backend/services/memory*"), false],
  ["git log pathspec", "git log --oneline -5 -- src/*.ts", Z("src/*.ts"), true],
  ["git diff ref:path", "git diff main:src/cli*.ts HEAD:src/cli.ts", Z("main:src/cli*.ts"), true],
  ["grep bracket pattern after a pipe", "git merge --ff-only origin/fix && ls backend/migrations | grep 202609081[34]", `Updating a..b\n${Z("202609081[34]")}`, false],
  ["grep -e pattern", "grep -n -e foo.* -e bar src/a.ts", Z("foo.*"), true],
  ["one of two errors ties to --include", "git pull -q --ff-only origin beta; grep -n cap -A4 lib/constants*.ts; grep -rn deliver lib --include=*.ts", `${Z("lib/constants*.ts")}\n${Z("--include=*.ts")}`, false],
];

/** The wrong shapes: a filesystem path given to a file-handling command, a for-in list, and the like (all failed, so the look-only exit-0 rule can't be what drops them). */
const ZSH_WRONG: Array<[string, string, string, boolean]> = [
  ["ls of a path glob", 'B="/tmp/bench"; ls -la "$B/runs/"*results*.jsonl 2>/dev/null', Z("/tmp/bench/runs/*results*.jsonl"), true],
  ["rm -rf of a scratch glob", `SP=${S}; rm -rf $SP/graftidx/*; echo done`, `${Z(`${S}/graftidx/*`)}\ndone`, true],
  ["du of a tilde glob", "du -sh ~/.cache/x ~/Library/*/toolname* 2>/dev/null", Z("/Users/dev/Library/*/toolname*"), true],
  ["cat of run results", 'cd /tmp/run && cat runs/trial-t*/result.json 2>/dev/null; echo "=== procs"', Z("runs/trial-t*/result.json", 5), true],
  ["mv of dot files", "cd /home/dev/video && mv my-video/* my-video/.[!.]* . 2>/dev/null; rmdir my-video", Z("my-video/.[!.]*"), true],
  ["a for-in list", 'for f in apps/web/.env.local apps/web/.env.prod*; do [ -f "$f" ] && echo "$f"; done', Z("apps/web/.env.prod*"), true],
  ["grep of file globs (not its pattern)", 'grep -n "AuditRequestInfo" backend/internal/events/*.go 2>/dev/null | head', Z("backend/internal/events/*.go"), true],
  ["ls after a git grep that has no glob", 'git grep -ln "ImageResponse" -- app lib | head; ls app/**/opengraph-image* app/opengraph-image* 2>/dev/null', Z("app/opengraph-image*"), true],
  ["cat > file, then ls of a glob", `cd ${S}/tools && cat > a.mjs <<'EOF'\nconsole.log(1)\nEOF\nls ../shots/marks/*.png`, Z("../shots/marks/*.png", 4), true],
  ["wc of a path glob", "wc -l src/*.snap", Z("src/*.snap"), true],
  ["cp of a path glob", "cp build/*.o /tmp/x/", Z("build/*.o"), true],
  ["head and tail of path globs", "head -5 logs/*.log; tail -3 out/*.txt", Z("logs/*.log"), true],
  ["git show of a tree path (not grep/log/diff)", "git show origin/main:src/init*", Z("origin/main:src/init*"), true],
  ["a ?-glob in a plain file name", "ls file?.txt", Z("file?.txt"), true],
  ["an error naming a word the command doesn't have", "grep -rn x --include=*.ts src", Z("lib/*.go"), true],
];

test("D147 zsh-no-match: the right shapes still fire", () => {
  for (const [why, cmd, out, failed] of ZSH_RIGHT) assert.equal(matchWall(out, cmd, failed), "zsh-no-match", why);
});

test("D147 zsh-no-match: a path glob given to a file-handling command is no hit", () => {
  for (const [why, cmd, out, failed] of ZSH_WRONG) assert.equal(matchWall(out, cmd, failed), null, why);
});

test("D147 zsh-no-match: the 1b safeguards stay (quoted glob, printed error, look-only exit 0)", () => {
  assert.equal(matchWall(Z("--include=*.ts"), "grep -rn x --include='*.ts' src", true), null, "quoted, so zsh never globbed it");
  assert.equal(matchWall(Z("--include=*.ts"), 'echo "(eval):1: no matches found: --include=*.ts"; exit 1', true), null, "an echo of the error");
  assert.equal(matchWall(Z("--include=*.ts"), "npm test", true), null, "no glob in the command");
  assert.equal(matchWall(Z("--include=*.ts"), "grep -rn x --include=*.ts src | head", false), null, "look-only at exit 0");
  assert.equal(matchWall(Z("--include=*.ts"), "env LC_ALL=C grep -rn x --include=*.ts src; npm run build | tail -3", false), "zsh-no-match", "a wrapper is read through, exit 0 on a piped work command");
});
