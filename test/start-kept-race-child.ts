/**
 * Child of the kept-notice race test (start-kept-notice-race.test.ts): waits for the shared start time, then runs
 * one session start's kept notice and prints what it got. Not a test file itself.
 */
import { keptNotice } from "../src/claude/start-init.js";

const [trail, repoKey, at] = process.argv.slice(2) as [string, string, string];
const start = Number(at);
while (Date.now() < start) { /* both children start the same millisecond */ }
const line = keptNotice(repoKey, { HOME: "/nonexistent", TRAIL_HOME: trail }, new Date());
process.stdout.write(JSON.stringify({ line }));
