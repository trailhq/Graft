/**
 * Bakes the PostHog key into the built `dist/telemetry/key.js` at publish time.
 *
 * This is what makes "forks never send" true by construction rather than by
 * policy. The key exists only in the published tarball: the repository holds an
 * empty string, so a clone, a fork, a CI build, and a contributor's local
 * `npm run build` all produce a graft whose telemetry module short-circuits on
 * the very first check.
 *
 * Runs from `prepublishOnly`, after `npm run build`. Without GRAFT_POSTHOG_KEY
 * in the environment it prints a warning and changes nothing — publishing a
 * telemetry-less build is a valid thing to do, and it must never be a hard
 * failure at the moment someone is trying to ship.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const target = join(root, 'dist', 'telemetry', 'key.js');

const key = process.env.GRAFT_POSTHOG_KEY ?? '';
const host = process.env.GRAFT_POSTHOG_HOST ?? '';

if (!key) {
  console.warn('⚠ GRAFT_POSTHOG_KEY not set — publishing a build that sends no telemetry.');
  process.exit(0);
}
if (!existsSync(target)) {
  console.warn(`⚠ ${target} not found — did the build run? Skipping the telemetry key stamp.`);
  process.exit(0);
}
// A key with a quote or a newline in it would break the generated literal (and
// is not a PostHog key). Refuse rather than emit something that won't parse.
if (!/^[A-Za-z0-9_-]+$/.test(key)) {
  console.error('✗ GRAFT_POSTHOG_KEY contains characters that are not valid in a project key.');
  process.exit(1);
}
if (host && !/^https:\/\/[A-Za-z0-9.-]+(:\d+)?$/.test(host)) {
  console.error('✗ GRAFT_POSTHOG_HOST must be a plain https origin, e.g. https://eu.i.posthog.com');
  process.exit(1);
}

const src = readFileSync(target, 'utf8');
let out = src.replace(/const BAKED_KEY = ['"][^'"]*['"];/, `const BAKED_KEY = '${key}';`);
if (host) out = out.replace(/const BAKED_HOST = ['"][^'"]*['"];/, `const BAKED_HOST = '${host}';`);

if (out === src) {
  console.error('✗ could not find BAKED_KEY in dist/telemetry/key.js — the stamp target moved.');
  process.exit(1);
}
writeFileSync(target, out);
console.log(`✓ telemetry key stamped into dist/telemetry/key.js${host ? ` (host ${host})` : ''}`);
