/**
 * The regular expression `graft grep` and `graft_find_all` search with, built
 * from the pattern the person (or their agent) typed. A grep takes a regex by
 * design, so the pattern's syntax is kept; what this adds is that the RegExp
 * is never made from the raw text:
 *
 * - every literal character goes through the metacharacter escape, and only
 *   regex syntax from a fixed set is written as itself, so the source handed
 *   to `RegExp` is the typed pattern, character for character, rebuilt from
 *   known parts;
 * - a repeat of a group that already repeats (`(a+)+`, `(\w*\s)*`) is refused
 *   with a SyntaxError, as an invalid pattern is: on a long line it backtracks
 *   exponentially and holds the search (the MCP server with it) for minutes.
 *   `--fixed` still searches for such text literally.
 *
 * Every other pattern compiles to exactly what `new RegExp(pattern)` gives,
 * and an invalid one still throws `RegExp`'s own SyntaxError.
 */

/** One literal character, escaped when it is a regex metacharacter (`.` → `\.`). */
const literal = (c: string): string => c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A metacharacter as regex syntax: each written from a constant, never from the pattern. */
function syntax(c: string): string {
  switch (c) {
    case ".": return ".";
    case "*": return "*";
    case "+": return "+";
    case "?": return "?";
    case "^": return "^";
    case "$": return "$";
    case "{": return "{";
    case "}": return "}";
    case "(": return "(";
    case ")": return ")";
    case "|": return "|";
    case "[": return "[";
    case "]": return "]";
    case "\\": return "\\";
    default: throw new SyntaxError(`not regex syntax: ${c}`);
  }
}

const META = new Set([".", "*", "+", "?", "^", "$", "{", "}", "(", ")", "|", "[", "]", "\\"]);
/** `{n}`, `{n,}`, `{n,m}` at the start of the text: its bounds. */
const BRACES = /^\{(\d+)(,(\d*))?\}/;

/** Thrown for a repeat of a repeating group: a SyntaxError, so callers report it as they report an invalid pattern. */
export const NESTED_REPEAT =
  "a repeated group that repeats inside, like (a+)+, can take minutes on one long line; repeat only the inside, or use --fixed";

/**
 * `pattern` as a RegExp with `flags`, rebuilt from escaped literals and fixed syntax. Throws SyntaxError for an
 * invalid pattern, and for a repeat of a group that repeats inside (see NESTED_REPEAT).
 */
export function userRegExp(pattern: string, flags = ""): RegExp {
  let out = "";
  let inClass = false;
  // Per open group: whether anything in it repeats (a quantifier with a top over 1).
  const groups: boolean[] = [false];
  // What a quantifier here applies to: a group (and whether it repeats inside), another atom, or nothing.
  let last: { group: boolean; repeats: boolean } | null = null;
  const repeatNow = () => { groups[groups.length - 1] = true; };

  for (let i = 0; i < pattern.length; ) {
    const c = pattern[i]!;
    if (c === "\\") {
      const n = pattern[i + 1];
      // A trailing `\` is written as it is: RegExp refuses it in its own words.
      if (n === undefined) out += syntax("\\");
      else out += META.has(n) ? literal(n) : syntax("\\") + literal(n);
      i += n === undefined ? 1 : 2;
      last = { group: false, repeats: false };
      continue;
    }
    if (inClass) {
      if (c === "]") { inClass = false; last = { group: false, repeats: false }; }
      out += META.has(c) ? syntax(c) : literal(c);
      i++;
      continue;
    }
    if (!META.has(c)) {
      out += literal(c);
      last = { group: false, repeats: false };
      i++;
      continue;
    }
    const braces = c === "{" ? BRACES.exec(pattern.slice(i)) : null;
    if (c === "*" || c === "+" || c === "?" || braces) {
      const repeats = braces ? (braces[2] !== undefined ? braces[3] === "" || Number(braces[3]) > 1 : Number(braces[1]) > 1) : c !== "?";
      if (repeats && last?.group && last.repeats) throw new SyntaxError(`Invalid regular expression: /${pattern}/: ${NESTED_REPEAT}`);
      if (repeats) repeatNow();
      if (braces) {
        out += syntax("{");
        for (const d of braces[0].slice(1, -1)) out += literal(d);
        out += syntax("}");
        i += braces[0].length;
      } else {
        out += syntax(c);
        i++;
      }
      // A lazy repeat (`+?`): the `?` is part of it.
      if (pattern[i] === "?") { out += syntax("?"); i++; }
      last = null;
      continue;
    }
    if (c === "[") {
      inClass = true;
      out += syntax("[");
      i++;
      if (pattern[i] === "^") { out += syntax("^"); i++; }
      continue;
    }
    if (c === "(") {
      groups.push(false);
      out += syntax("(");
      i++;
      // `(?:`, `(?=`, `(?<name>`: the `?` opens the group's kind, it repeats nothing.
      if (pattern[i] === "?") { out += syntax("?"); i++; }
      last = null;
      continue;
    }
    if (c === ")") {
      const repeats = groups.length > 1 ? groups.pop()! : false;
      if (repeats) repeatNow();
      out += syntax(")");
      last = { group: true, repeats };
      i++;
      continue;
    }
    // `.` is an atom; `^`, `$` and `|` leave nothing to repeat; a lone `{`, `}` or `]` is a literal in this mode.
    out += syntax(c);
    last = c === "." || c === "{" || c === "}" || c === "]" ? { group: false, repeats: false } : null;
    i++;
  }
  return new RegExp(out, flags);
}
