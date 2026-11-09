/**
 * The regex `graft grep` builds from a typed pattern (src/search/user-regexp.ts): the same RegExp as the pattern
 * itself for every pattern with metacharacters a grep takes, the same SyntaxError for an invalid one, and a refusal
 * only for a repeat of a group that repeats inside. Made-up files only.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { grepGraph } from '../src/search/grep.js';
import { NESTED_REPEAT, userRegExp } from '../src/search/user-regexp.js';
import type { GraphV1 } from '../src/graph/types.js';

const PATTERNS = [
  'NEEDLE', 'a.b', 'a\\.b', '^\\s*export\\s+(?:async\\s+)?function\\s+\\w+', 'retries\\s*=\\s*\\d+', 'foo|bar|baz$',
  '\\(x\\)', '[.*+?^${}()|\\]\\\\]', '[^a-z]', '[]', '[^]', 'a{2}', 'a{2,}', 'a{2,5}', 'a{,5}', 'x{', '}', ']', 'a+?b*?c??',
  '(ab)+', '(?:foo|bar)+', '(a+)?', '\\d+(\\.\\d+)?', '(?<year>\\d{4})-(?<m>\\d\\d)', '(?=x)y', '(?!x)y', '(?<=\\$)\\d+', '(?<!\\\\)n',
  '(a)\\1', '\\bword\\b', '\\x41\\u0042\\cJ', '\\/path\\/to', 'path/to', 'naïve 日本 😀', 'a\\-b', '$^', '\\$\\{HOME\\}',
];

test('userRegExp: every pattern a grep takes is the same RegExp as the pattern itself, flags too', () => {
  for (const p of PATTERNS) {
    for (const flags of ['', 'i']) {
      const r = userRegExp(p, flags);
      const plain = new RegExp(p, flags);
      assert.equal(r.source, plain.source, p);
      assert.equal(r.flags, plain.flags, p);
    }
  }
});

test('userRegExp: an invalid pattern throws the SyntaxError RegExp throws', () => {
  for (const p of ['(', 'a)', '[a', '*a', 'a**', '\\', '(?<x>a', 'a{2}{3}']) {
    assert.throws(() => userRegExp(p), SyntaxError, p);
    let plain: unknown = null;
    try { new RegExp(p); } catch (e) { plain = e; }
    assert.ok(plain instanceof SyntaxError, `RegExp refuses ${p} too`);
  }
});

test('userRegExp: a repeat of a group that repeats inside is refused as an invalid pattern; one repeat level is not', () => {
  for (const p of ['(a+)+', '(a*)*', '(\\w+\\s?)*', '((ab)+c)+', '((a+)?)+', '(x{2,})+', '(?:a|b+){3,}', '(a+)+?']) {
    assert.throws(() => userRegExp(p), (e: unknown) => e instanceof SyntaxError && e.message.includes(NESTED_REPEAT), p);
  }
  for (const p of ['(a+)', '(a+)?', '(a+){1}', '(a+){0,1}', '(ab)*', '(a|b)+', 'a+b+c*', '[a+]+', '\\(a+\\)+', '(a{1})+']) {
    assert.doesNotThrow(() => userRegExp(p), p);
  }
});

test('grepGraph: regex metacharacters in the pattern search as regex syntax, and a nested repeat is a SyntaxError', () => {
  const d = mkdtempSync(join(tmpdir(), 'graft-grep-meta-'));
  writeFileSync(join(d, 'x.ts'), 'const retries = 5;\nconst a = fn(x);\ncost(${HOME}) + 1\naxb\n');
  const graph: GraphV1 = {
    meta: { version: 1, nodeCount: 1, edgeCount: 0, languages: [] },
    nodes: [{ id: 'x.ts', name: 'x.ts', kind: 'file', path: 'x.ts', span: 'L1-L4', signature: null, exported: true, origin: 'ast', body_hash: '', summary_state: 'pending', summary: null, crux: null }],
    edges: [],
  };
  const lines = (p: string, opts = {}) => grepGraph(graph, d, p, opts).groups.flatMap((g) => g.hits.map((h) => h.line));
  assert.deepEqual(lines('retries\\s*=\\s*\\d+'), [1]);
  assert.deepEqual(lines('fn\\(x\\)'), [2]);
  assert.deepEqual(lines('\\$\\{HOME\\}'), [3]);
  assert.deepEqual(lines('a.b'), [4], '`.` is any character');
  assert.deepEqual(lines('^(const|cost)\\b'), [1, 2, 3]);
  assert.deepEqual(lines('RETRIES', { ignoreCase: true }), [1]);
  assert.deepEqual(lines('${HOME}', { fixed: true }), [3], '--fixed searches the text as typed');
  assert.throws(() => grepGraph(graph, d, '(a+)+'), SyntaxError);
  assert.throws(() => grepGraph(graph, d, 'fn('), SyntaxError);
});
