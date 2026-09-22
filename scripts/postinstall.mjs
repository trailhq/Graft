// Prints a one-line nudge after install, and records the anonymous `install`
// event. Never fails the install.
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

/**
 * Record the install, then hand the queue straight to a detached child.
 *
 * Sending here rather than letting the daily flush pick it up is the entire
 * point of the event: the machine we most want to count is the one that installs
 * graft and never runs a command, and that machine never reaches a flush. The
 * child is detached with stdio ignored, so npm waits on no socket and an offline
 * install looks like any other.
 *
 * Every gate still applies — a fork or a local build has no key, and CI,
 * `DO_NOT_TRACK` and `graft telemetry disable` all close it. See TELEMETRY.md.
 */
async function recordInstall() {
  // `dist/` is absent when this runs from a clone, where `prepare` builds AFTER
  // postinstall. Nothing to record there, and a fork has no key regardless.
  const entry = join(root, 'dist', 'telemetry', 'index.js');
  const cli = join(root, 'dist', 'cli.js');
  if (!existsSync(entry) || !existsSync(cli)) return;
  const mod = await import(pathToFileURL(entry).href);
  // A `dist/` from an older version has no such export. Absent, not broken.
  if (typeof mod.trackInstallIfNew !== 'function') return;
  // npm sets this for `npm i -g`; only its value 'true' means global.
  mod.trackInstallIfNew({ global: process.env.npm_config_global === 'true' });
  const child = spawn(process.execPath, [cli, '_telemetry-flush'], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
}

try {
  if (process.env.CI) process.exit(0);
  const dir = process.env.INIT_CWD || process.cwd();
  // Its own catch: the nudge is the part a user sees, and a telemetry fault must
  // not be able to silence it.
  try { await recordInstall(); } catch { /* telemetry is never worth an error */ }
  if (existsSync(join(dir, '.claude', 'helpers', 'graft-statusline.cjs'))) process.exit(0);
  console.log('\n  Graft installed. Run `npx graft init` to enable the Claude Code integration (statusline + hooks + auto-sync).\n');
} catch {
  /* never fail an install */
}
