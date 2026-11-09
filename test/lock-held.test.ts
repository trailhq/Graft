/**
 * A failed open of `<path>.lock` that means someone else holds it. On Windows a
 * lock being deleted by another process fails with EPERM or EBUSY, not EEXIST:
 * that is the lock being let go, so it is waited on, not thrown (it threw in CI).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { lockHeld } from "../src/util/private-fs.js";

test("EEXIST is a held lock everywhere; EPERM and EBUSY only on Windows", () => {
  for (const p of ["linux", "darwin", "win32"] as const) assert.equal(lockHeld("EEXIST", p), true, p);
  assert.equal(lockHeld("EPERM", "win32"), true);
  assert.equal(lockHeld("EBUSY", "win32"), true);
  assert.equal(lockHeld("EPERM", "linux"), false, "a real permission error elsewhere still throws");
  assert.equal(lockHeld("EACCES", "win32"), false);
  assert.equal(lockHeld(undefined, "win32"), false);
});
