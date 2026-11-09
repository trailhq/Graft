/**
 * Claude Code's how-to files (`~/.claude/projects/<key>/memory/*.md`), read
 * only (design 4.5, b5): evidence for a skill, and a preference they already
 * say. Their text is never copied, sent or written. Synthetic files only.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { after } from "node:test";
import { join } from "node:path";
import { howtoDescribes, howtoKnows, readHowtos } from "../src/init/howtos.js";
import { tmpRepo } from "./helpers.js";

const roots: string[] = [];
after(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function tree() {
  const root = tmpRepo("howtos");
  roots.push(root);
  const claude = join(root, ".claude");
  const mem = (key: string) => join(claude, "projects", key, "memory");
  mkdirSync(mem("-home-dev-shop"), { recursive: true });
  mkdirSync(mem("-home-dev-web"), { recursive: true });
  writeFileSync(join(mem("-home-dev-shop"), "npm-publish-flow.md"), "# Releasing acme-cli\n\nTo release, run npm publish with the tarball, then npm view to check.\n");
  writeFileSync(join(mem("-home-dev-shop"), "style.md"), "# Style\n\n- Explain it simply, one example first.\n- Never use em dashes in copy.\n");
  writeFileSync(join(mem("-home-dev-shop"), "notes.txt"), "not a how-to\n");
  writeFileSync(join(mem("-home-dev-web"), "web.md"), "# Web\n\nDeploy with vercel.\n");
  return { claude, mem };
}

test("reads the .md how-tos of the keys asked for, and changes nothing", () => {
  const { claude, mem } = tree();
  const before = readdirSync(mem("-home-dev-shop")).map((f) => [f, readFileSync(join(mem("-home-dev-shop"), f), "utf8"), statSync(join(mem("-home-dev-shop"), f)).mtimeMs]);
  const h = readHowtos(["-home-dev-shop", "-no-such-key", "../escape"], claude);
  assert.deepEqual(h.map((x) => x.file).sort(), ["npm-publish-flow.md", "style.md"]);
  const after = readdirSync(mem("-home-dev-shop")).map((f) => [f, readFileSync(join(mem("-home-dev-shop"), f), "utf8"), statSync(join(mem("-home-dev-shop"), f)).mtimeMs]);
  assert.deepEqual(after, before, "bytes and mtimes unchanged");
});

test("a how-to that names the job's program and its words is evidence; one that doesn't is not", () => {
  const { claude } = tree();
  const h = readHowtos(["-home-dev-shop", "-home-dev-web"], claude);
  assert.equal(howtoDescribes(h, "release", ["npm"]), "npm-publish-flow.md");
  assert.equal(howtoDescribes(h, "tests", ["npm"]), null, "npm named, but nothing about tests");
  assert.equal(howtoDescribes(h, "release", ["cargo"]), null, "release words, another program");
  assert.equal(howtoDescribes(h, "ship", ["vercel"]), "web.md");
});

test("a preference a how-to already says is known; another is not", () => {
  const { claude } = tree();
  const h = readHowtos(["-home-dev-shop"], claude);
  assert.equal(howtoKnows(h, "explain it simply, one example first"), true);
  assert.equal(howtoKnows(h, "never use em dashes"), true);
  assert.equal(howtoKnows(h, "always run the linter first"), false);
});
