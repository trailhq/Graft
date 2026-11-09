/**
 * Whether a command failed, read from what it printed as well as from the
 * host's error flag. In real sessions most failed commands exited 0, because
 * their output was piped through `| tail` or `| head`; only the text says so.
 * Checked on the head and tail of the output, where a failure says so.
 */
import { flatLine } from "../notes/flatten.js";

/** What a failed command prints, in the tools these sessions run. */
export const FAILED_TEXT = new RegExp(
  [
    "npm ERR!",
    "npm error",
    "command not found",
    "No such file or directory",
    "Permission denied",
    "^fatal:",
    "^error(?:\\[\\w+\\])?:",
    "Traceback \\(most recent call last\\)",
    "Cannot find module",
    "ModuleNotFoundError",
    "^panic:",
    // Claude Code's "Exit code 1", Codex's "Exit code: 1", Go's "exit status 1".
    "Exit code:? [1-9]",
    "exit status [1-9]",
    "exited with (?:code )?[1-9]",
    "\\b(?:401 Unauthorized|403 Forbidden)\\b",
    "Cannot connect to the Docker daemon",
    "Unable to locate",
  ].join("|"),
  "im",
);

/**
 * What a test runner prints when it fails, upper case only: pnpm's error
 * codes, jest's and go's `FAIL` lines, vitest's ` FAIL ` line and summary,
 * and go's `--- FAIL:` subtests. Kept apart from FAILED_TEXT because case
 * matters: `fail | lint` in a checks table and "Fail if the index is stale"
 * in a script's help are not a runner saying it failed.
 */
export const FAILED_RUNNER_TEXT = /ERR_PNPM_|^ ?FAIL(?:\s|$)|^\s*--- FAIL:|^\s*Test Files\s+\d+ failed|^\s*Tests\s+\d+ failed/m;

/** Error codes, upper case only: a UUID's hex block (`-e404-`) is not one. */
const ERROR_CODE = /\bE(?:401|403|404|ACCES|NOENT|CONNREFUSED|NOSPC)\b/;

const HEAD = 1500;
const TAIL = 2500;

/** Whether a command's output reads like a failure. */
export function failedText(text: string): boolean {
  const ends = text.length > HEAD + TAIL ? `${text.slice(0, HEAD)}\n${text.slice(-TAIL)}` : text;
  return FAILED_TEXT.test(ends) || FAILED_RUNNER_TEXT.test(ends) || ERROR_CODE.test(ends);
}

/** Claude Code's own first line on a failed call: true, but it says nothing about what failed. */
const BARE_EXIT = /^\s*Exit code:? \d+\s*$/i;

/** First line in the head or tail of `text` that says it failed (failedText's patterns), flatLine(.., 160); null when none. */
export function errorLine(text: string): string | null {
  if (typeof text !== "string" || !text) return null;
  const parts = text.length > HEAD + TAIL ? [text.slice(0, HEAD), text.slice(-TAIL)] : [text];
  let bare: string | null = null;
  for (const part of parts) {
    for (const line of part.split(/\r?\n/)) {
      if (!FAILED_TEXT.test(line) && !FAILED_RUNNER_TEXT.test(line) && !ERROR_CODE.test(line)) continue;
      if (BARE_EXIT.test(line)) {
        bare ??= line;
        continue;
      }
      const flat = flatLine(line, 160);
      if (flat) return flat;
    }
  }
  return bare === null ? null : flatLine(bare, 160) || null;
}
