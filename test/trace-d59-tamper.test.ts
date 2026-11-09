/**
 * Decision D59(e): the tamper check (design 4.1, D55) also catches git
 * writing inside Trail's folders (`git -C <trail home> ...`, `--git-dir`, or
 * a shell already sitting there) and `xargs` handing Trail's paths to a
 * program that writes them. Reading with git or xargs is not tampering.
 * Synthetic paths only.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { tamperOf } from "../src/trace/tamper.js";

const HOME = "/home/dev";
const CTX = { trailHome: "/home/dev/.trail", transcriptPath: "/home/dev/.claude/projects/-home-dev-shop/5f0c.jsonl", home: HOME };
const sh = (cmd: string, folder: string | null = "/home/dev/shop") => tamperOf("Bash", { command: cmd }, cmd, { ...CTX, folder });

test("D59e: git writing inside Trail's home (by -C, --git-dir, or the folder it runs in) is tampering; reading it is not", () => {
  for (const cmd of [
    "git -C ~/.trail add -A && git -C ~/.trail commit -m 'sync'",
    'git -C "$HOME/.trail/repos/acme-shop" checkout -- skills',
    "git -C /home/dev/.trail reset --hard HEAD~1",
    "git -c user.name=bot -C ~/.trail commit -am x",
    "git --git-dir=/home/dev/.trail/.git --work-tree=/home/dev/.trail checkout .",
    "git -C ~/.trail stash",
    "git -C ~/.trail branch -D old",
    "git -C ~/.trail config user.email bot@example.com",
    "git -C ~ -C .trail clean -fdx",
    "cd ~/.trail && git commit -am x",
    "git -C ~/.claude/projects/-home-dev-shop init",
  ]) assert.ok(sh(cmd), cmd);
  assert.equal(sh("git commit -am x", "/home/dev/.trail"), "Bash git commit", "the shell already sits in Trail's home");
  for (const cmd of [
    "git -C ~/.trail status", "git -C ~/.trail log --oneline -5", "git -C ~/.trail diff HEAD~1", "git -C ~/.trail show HEAD:skills.json",
    "git -C ~/.trail branch", "git -C ~/.trail branch -a", "git -C ~/.trail tag -l", "git -C ~/.trail remote -v", "git -C ~/.trail config --get remote.origin.url",
    "git -C ~/.trail stash list", "git -C /home/dev/shop commit -am x", "git -C ~/.trail-lab commit -am x", "git commit -am x",
    "git -C ~/.claude/projects/-home-dev-shop/memory commit -am x",
  ]) assert.equal(sh(cmd), null, cmd);
});

test("D59e: xargs handing Trail's paths to a writer is tampering; to a reader, or other paths, is not", () => {
  for (const cmd of [
    "find ~/.trail/runs -name '*.json' | xargs rm",
    "ls -d ~/.trail/runs/* | xargs rm -f",
    "find ~/.trail -name '*.json' -print0 | xargs -0 rm",
    "find /tmp/forged -name '*.json' | xargs -I{} cp {} ~/.trail/runs/",
    "ls /tmp/forged | xargs -I % cp /tmp/forged/% /home/dev/.trail/runs/%",
    "echo ~/.trail/offers.jsonl | xargs truncate -s 0",
    "find ~/.trail -name 'skills.json' | xargs sed -i 's/needs-fix/active/'",
    "find ~/.trail/runs -type f | xargs -I{} mv {} /tmp/",
    "find ~/.claude/projects/-home-dev-shop -name '*.jsonl' | xargs rm",
    "find /tmp/old ~/.trail/runs -name '*.json' | xargs rm",
  ]) assert.ok(sh(cmd), cmd);
  assert.ok(sh("ls | xargs rm", "/home/dev/.trail/runs"), "names read in Trail's folder, removed there");
  for (const cmd of [
    "find ~/.trail/runs -name '*.json' | xargs cat",
    "find ~/.trail/runs -name '*.json' | xargs -I{} cp {} /tmp/backup/",
    "find ~/.trail -name '*.json' | xargs grep -l needs-fix",
    "find /tmp/old -name '*.log' | xargs rm",
    "find . -name '*.log' | xargs rm",
    "ls | xargs rm",
    "find ~/.claude/projects/-home-dev-shop/memory -name '*.md' | xargs rm",
  ]) assert.equal(sh(cmd), null, cmd);
});
