/**
 * The tamper check (design 4.1): a session where the agent wrote Trail's
 * files or the host's transcripts can never save a skill. What counts is a
 * write to them: an edit tool on the file, a redirect, a program that writes
 * its arguments (tee, cp, mv, rm, sed -i, ...), a folder the agent cd'd into,
 * or an interpreter writing a path it names. Reading them, a heredoc body that
 * only mentions them, and Claude Code's own memory files are not tampering.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { tamperOf } from "../src/trace/tamper.js";

const HOME = "/home/dev";
const CTX = { trailHome: "/home/dev/.trail", transcriptPath: "/home/dev/.claude/projects/-home-dev-shop/5f0c.jsonl", home: HOME };
const bash = (cmd: string, folder: string | null = "/home/dev/shop") => tamperOf("Bash", { command: cmd }, cmd, { ...CTX, folder });
const edit = (tool: string, path: string) => tamperOf(tool, { file_path: path }, null, CTX);

test("edit tools: Trail's home and transcripts are protected; Claude Code's memory files are not", () => {
  assert.equal(edit("Write", "/home/dev/.trail/runs/r-1001-aaaa.json"), `Write ${resolve("/home/dev/.trail/runs/r-1001-aaaa.json")}`);
  assert.equal(edit("Edit", "~/.trail/settings.json"), `Edit ${resolve("/home/dev/.trail/settings.json")}`);
  assert.equal(edit("Edit", "/home/dev/.claude/projects/-home-dev-shop/5f0c.jsonl"), `Edit ${resolve("/home/dev/.claude/projects/-home-dev-shop/5f0c.jsonl")}`);
  assert.equal(edit("Write", "/home/dev/.claude/projects/-home-dev-shop/other-session.jsonl"), `Write ${resolve("/home/dev/.claude/projects/-home-dev-shop/other-session.jsonl")}`);
  assert.equal(tamperOf("NotebookEdit", { notebook_path: "/home/dev/.trail/x.ipynb" }, null, CTX), `NotebookEdit ${resolve("/home/dev/.trail/x.ipynb")}`);
  assert.equal(edit("Write", "/home/dev/.claude/projects/-home-dev-shop/memory/deploy-notes.md"), null);
  assert.equal(edit("Edit", "/home/dev/.claude/projects/-home-dev-shop/memory/MEMORY.md"), null);
  assert.equal(edit("Write", "/home/dev/.trail-lab/x"), null);
  assert.equal(edit("Write", "/home/dev/shop/src/cart.ts"), null);
});

test("Bash writes to protected paths: redirects, writers, sed -i, cd into the folder, interpreters naming the path", () => {
  const writes = [
    "echo x >> ~/.trail/offers.jsonl",
    'echo x > "$HOME/.trail/settings.json"',
    "printf 'y' >${HOME}/.trail/state/skills.json",
    'rm "$TRAIL_HOME/state/skills.json"',
    "cp /tmp/forged.json ~/.trail/runs/r-1001-aaaa.json",
    "mv x.json /home/dev/.trail/receipts/s.json",
    "tee -a ~/.trail/offers.jsonl < line.txt",
    `echo '{"type":"user"}' >> ${CTX.transcriptPath}`,
    "sed -i '' 's/no/yes/' ~/.claude/projects/-home-dev-shop/5f0c.jsonl",
    "cd ~/.trail && rm runs/r-1001-aaaa.json",
    "cd /home/dev/.claude/projects/-home-dev-shop && echo x >> 5f0c.jsonl",
    "python3 - <<'EOF'\nopen('/home/dev/.trail/runs/r-1001-aaaa.json', 'w').write('{}')\nEOF",
    "node -e \"require('fs').appendFileSync('/home/dev/.claude/projects/-home-dev-shop/5f0c.jsonl', 'x')\"",
    "rm -rf ~/.claude/projects/-home-dev-shop",
  ];
  for (const cmd of writes) assert.ok(bash(cmd), cmd);
  assert.equal(bash("echo x >> offers.jsonl", "/home/dev/.trail"), "Bash echo", "the agent's shell is already in the folder");
  assert.equal(bash("node /home/dev/.trail/bin/trail-hooks.cjs stop < p.json"), "Bash trail-hooks.cjs");
  assert.ok(bash("trail skills list > ~/.trail/skills.txt"), "Trail's own command writing a Trail file is not exempt");
  assert.equal(bash("trail skills add release-npm --run r-1001-aaaa"), null, "Trail's own command is exempt");
});

test("Bash that only reads or mentions protected paths, or writes memory files, is not tampering", () => {
  const fine = [
    "cat ~/.trail/runs/r-1001-aaaa.json && ls $HOME/.trail",
    "grep -o 'deck' ~/.claude/projects/-home-dev-shop/5f0c.jsonl | sort -u | head -10",
    "python3 - <<'EOF'\nimport json\nfor l in open('/home/dev/.claude/projects/-home-dev-shop/5f0c.jsonl'):\n    print(len(l))\nEOF",
    "cat > design.html <<'EOF'\n<p>Trail keeps run sheets in ~/.trail/runs and reads ~/.claude/projects/x.jsonl</p>\nEOF",
    "python3 - <<'EOF'\np='src/home.ts'\ns=open(p).read().replace('~/.trail', '$TRAIL_HOME')\nopen(p,'w').write(s)\nEOF",
    "cd ~/.claude/projects/-home-dev-shop/memory && cat >> MEMORY.md <<'EOF'\n- [Deploy](deploy.md)\nEOF",
    "cat > ~/.claude/projects/-home-dev-shop/memory/deploy.md <<'EOF'\nnotes\nEOF",
    "sed -i '' 's/a/b/' ~/.claude/projects/-home-dev-shop/memory/MEMORY.md",
    "diff <(sort a) <(sort b) > /tmp/out.txt; echo ~/.trail",
    "npm test 2>&1 | tee /tmp/test.log",
    "echo done > /dev/null",
  ];
  for (const cmd of fine) assert.equal(bash(cmd), null, cmd);
});

test("the path can reach the write through a variable, a Path receiver, a home join, bash -c, or a cd in the middle", () => {
  const writes = [
    "python3 - <<'EOF'\nimport os\np = os.path.expanduser('~/.trail/runs/r-1001-aaaa.json')\nwith open(p, 'w') as f:\n    f.write('{}')\nEOF",
    "python3 - <<'EOF'\nfrom pathlib import Path\nPath('/home/dev/.trail/state/skills.json').write_text('{}')\nEOF",
    "python3 - <<'EOF'\nfrom pathlib import Path\nroot = Path.home() / '.trail'\nsheet = root / 'runs' / 'x.json'\nsheet.write_text('{}')\nEOF",
    "node -e \"const fs=require('fs');fs.writeFileSync(require('path').join(require('os').homedir(), '.trail', 'offers.jsonl'), 'x')\"",
    "bash -c 'echo x >> ~/.trail/offers.jsonl'",
    "ls && cd ~/.trail && touch runs/x.json",
    "echo x>~/.trail/offers.jsonl",
    "find ~/.trail/runs -name '*.json' -delete",
    "dd if=/dev/zero of=/home/dev/.trail/state/skills.json bs=1 count=1",
    "sudo tee ~/.trail/settings.json < s.json",
    "git diff --output=/home/dev/.trail/runs/x.json",
    "curl -s -o ~/.trail/runs/r-1001-aaaa.json https://example.com/sheet.json",
    "sort -o ~/.trail/offers.jsonl offers.jsonl",
    "rm -rf ~/.claude",
    "mv ~/.trail ~/.trail-old",
  ];
  for (const cmd of writes) assert.ok(bash(cmd), cmd);
});

test("copies out of the home, writes of other files, and a script fed a heredoc are not tampering", () => {
  const fine = [
    "cp ~/.trail/runs/r-1001-aaaa.json /tmp/sheet.json",
    "python3 - <<'EOF'\np = 'docs/home.md'\ns = open(p).read()\nopen(p, 'w').write(s.replace('~/.trail', '$TRAIL_HOME'))\nEOF",
    "python3 -c \"import sys; open('out.txt', 'w').write('see ~/.trail/runs')\"",
    "python3 - <<'EOF'\nf = open('notes.txt', 'w')\nf.write('/home/dev/.trail/runs/x.json')\nEOF",
    "bash deploy.sh <<'EOF'\necho x >> ~/.trail/offers.jsonl\nEOF",
    "cd ~/.trail && cd /home/dev/shop && echo x > out.txt",
    "mv build/out.json dist/out.json",
    "curl -s -o /tmp/sheet.json https://example.com/sheet.json",
  ];
  for (const cmd of fine) assert.equal(bash(cmd), null, cmd);
  assert.equal(bash("echo x >> runs/x.json", null), null, "an unknown folder is not a guess");
  assert.equal(bash("echo x > $OUT/x.json", "/home/dev/.trail"), null, "nor is a variable only the shell knows");
  assert.equal(bash("node build.js 2>&1 | head -5", "/home/dev/.trail"), null, "running something in the folder writes nothing");
  assert.equal(bash("grep -o deck runs/r-1001-aaaa.json", "/home/dev/.trail"), null, "grep -o names no file");
  assert.equal(bash("python3 - <<'EOF'\nfrom pathlib import Path\nfor l in Path('/home/dev/.claude/projects/-home-dev-shop/5f0c.jsonl').open():\n    print(l[:80])\nEOF"), null);
  assert.ok(bash("python3 - <<'EOF'\nfrom pathlib import Path\nwith Path('/home/dev/.trail/offers.jsonl').open('a') as f:\n    f.write('x')\nEOF"));
});

test("find that only lists, and a variable holding what was read from a protected file, are not tampering", () => {
  const fine = [
    "cd ~/.claude/projects && find . -name '*.jsonl' -maxdepth 2 -exec stat -f '%Sm' {} + | sort | head -3",
    "find ~ -xdev -type f -size +300M -exec ls -lh {} \; | sort -rh | head",
    "python3 - <<'EOF'\nfrom pathlib import Path\nname = Path('/home/dev/.trail/latest').read_text().strip()\nopen(name, 'w').write('x')\nEOF",
    "python3 - <<'EOF'\nimport os\nroot = os.path.expanduser('~/.trail')\nlast = os.path.join(root, 'latest').read().strip()\nopen(last, 'w').write('x')\nEOF",
    "cd /tmp/work && python3 - <<'EOF'\nimport json\nraw = open('/home/dev/.claude/projects/-home-dev-shop/5f0c/tool-results/r.txt').read()\nd = json.loads(raw)\nopen('out.json', 'w').write(json.dumps(d))\nwith open(raw[:10], 'w') as f:\n    f.write('x')\nEOF",
  ];
  for (const cmd of fine) assert.equal(bash(cmd), null, cmd);
  assert.ok(bash("find ~/.trail -name '*.json' -exec rm {} +"));
  assert.ok(bash("python3 - <<'EOF'\nimport os\nbase = os.path.join(os.path.expanduser('~/.trail'), 'runs')\nopen(os.path.join(base, 'x.json'), 'w').write('{}')\nEOF"));
});

test("g5 review: a protected folder before a variable, code on stdin or in a here-string, and more home joins are writes", () => {
  const writes = [
    "echo '{}' > ~/.trail/sessions/$SID.json",
    'cp /tmp/x.json "$TRAIL_HOME/runs/${ID}.json"',
    'cat /tmp/x.json > "$HOME/.trail/sessions/$(ls ~/.trail/sessions | head -1)"',
    "echo x >> ~/.claude/projects/-home-dev-shop/`ls -t ~/.claude/projects/-home-dev-shop | head -1`",
    "echo x > runs/$ID.json && true",
    `echo 'open("/home/dev/.trail/sessions/a.json","w").write("{}")' | python3`,
    `python3 <<< 'open("/home/dev/.trail/sessions/a.json","w").write("{}")'`,
    "cat <<'EOF' | python3\nopen('/home/dev/.trail/runs/x.json','w').write('{}')\nEOF",
    "printf 'echo x > ~/.trail/offers.jsonl' | bash",
    "echo 'echo x >> ~/.trail/offers.jsonl' | sh -s",
    `node -e "require('fs').appendFileSync(require('os').homedir()+'/.claude/projects/-home-dev-shop/5f0c.jsonl','x')"`,
    `ruby -e 'File.write(Dir.home+"/.trail/sessions/a.json","x")'`,
  ];
  for (const cmd of writes) assert.ok(bash(cmd, cmd.startsWith("echo x > runs/") ? "/home/dev/.trail" : "/home/dev/shop"), cmd);
  const fine = [
    "cat ~/.trail/runs/$ID.json",
    "ls ~/.trail/sessions/$SID.json && wc -l ~/.trail/offers.jsonl",
    "cat ~/.trail/sessions/a.json | python3 -m json.tool",
    "git log --oneline | python3 scripts/count.py",
    "echo 'print(1)' | python3",
    "cat ~/.trail/runs/x.json | python3 -c 'import json,sys; print(len(json.load(sys.stdin)))'",
    `python3 <<< 'print(open("/home/dev/.trail/runs/x.json").read())'`,
    `node -e "require('fs').writeFileSync(require('os').homedir()+'/.claude/projects/-home-dev-shop/memory/notes.md','x')"`,
    "echo x > /tmp/$NAME.txt",
    "bash deploy.sh <<< 'echo x >> ~/.trail/offers.jsonl'",
  ];
  for (const cmd of fine) assert.equal(bash(cmd), null, cmd);
});
