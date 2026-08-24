// Generates the tiny `.cjs` shims committed into a repo's `.claude/helpers/`. Their only
// job is to locate the installed `@nanonets/graft` package's `dist/claude/<entry>.js` and
// call into it — so the real logic lives in the package and upgrades with it.
//
// Candidates, cheapest first (no subprocess for 1–3):
//   1. `bakedDir`   — the absolute `dist/claude` graft was running from at init time.
//                     Correct with zero guesswork for whoever ran `graft init`.
//   2. repo node_modules — a local dev-dep install.
//   3. `execDir/../lib`  — the cheap legacy guess (covers nvm / classic prefix layout).
//   4. `npm root -g`     — authoritative global dir, layout-agnostic. Only shelled out to
//                     when 1–3 all miss or fail to load; queried on demand — no on-disk
//                     cache, which on a shared machine would be a world-writable path an
//                     attacker could point at their own code for us to import.
//
// Among the candidates that exist we try the HIGHEST VERSION first, not the first hit.
// First-hit silently pinned users to a stale graft forever: `bakedDir` points into one
// Node install's global node_modules, so switching Node versions (nvm/volta) or moving
// the install leaves the old directory on disk and still winning, and
// `npm i -g @nanonets/graft@latest` upgrades a directory the shim never looks at.
//
// Existence is not enough. A stale or half-installed candidate whose file is on disk
// but fails to import used to disable every later one — the `.catch()` swallowed the
// load error and the hook silently no-op'd. Walk remaining candidates on *load*
// failure (import throw, or no `main`). Once `main()` has been reached it owns the
// outcome: retrying after it ran would repeat side effects.
function shim(entryFile: string, call: string, bakedDir: string): string {
  return `#!/usr/bin/env node
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');
const { execFileSync } = require('child_process');
const dir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const BAKED = ${JSON.stringify(bakedDir)};

// The dist/claude dir of @nanonets/graft resolved from a base whose node_modules is searched.
function fromPkg(base) {
  try {
    const pkg = require.resolve('@nanonets/graft/package.json', { paths: [base] });
    return path.join(path.dirname(pkg), 'dist', 'claude');
  } catch { return null; }
}

// The global node_modules dir per npm (handles Homebrew/Windows/volta). Queried on demand.
function globalRoot() {
  try {
    const root = execFileSync('npm', ['root', '-g'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], shell: process.platform === 'win32' }).trim();
    return root || null;
  } catch { return null; /* npm unavailable */ }
}

// The version of the package a dist/claude dir belongs to, or null if unreadable.
function versionOf(distClaude) {
  try {
    return JSON.parse(fs.readFileSync(path.join(distClaude, '..', '..', 'package.json'), 'utf8')).version || null;
  } catch { return null; }
}

// Numeric-dotted compare of the release part; an unreadable version loses to any known one.
function newer(a, b) {
  if (!a) return false;
  if (!b) return true;
  const p = (v) => String(v).split('-')[0].split('.').map((n) => Number(n) || 0);
  const pa = p(a), pb = p(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d > 0;
  }
  return false;
}

// Dirs in \`dirs\` that contain \`name\`, highest version first. Equal versions keep
// their original order (the comparator returns 0).
function ranked(dirs, name) {
  return dirs.filter((d) => d && fs.existsSync(path.join(d, name))).sort((a, b) => {
    const va = versionOf(a), vb = versionOf(b);
    if (newer(va, vb)) return -1;
    if (newer(vb, va)) return 1;
    return 0;
  });
}

async function launch(name, call) {
  const seen = new Set();
  const tryDir = async (d) => {
    if (!d || seen.has(d)) return false;
    seen.add(d);
    const f = path.join(d, name);
    if (!fs.existsSync(f)) return false;
    let mod;
    try { mod = await import(pathToFileURL(f).href); } catch { return false; }
    if (typeof mod.main !== 'function') return false;
    try { await call(mod); } catch { /* failed — do not block the session */ }
    return true; // main() was reached; do not try another candidate
  };
  // Cheap candidates first; only shell out to npm when every one of them misses *or* fails to load.
  for (const d of ranked([BAKED, fromPkg(dir), fromPkg(path.join(path.dirname(process.execPath), '..', 'lib'))], name)) {
    if (await tryDir(d)) return;
  }
  const gr = globalRoot();
  const global = gr && path.join(gr, '@nanonets', 'graft', 'dist', 'claude');
  if (await tryDir(global)) return;
  await tryDir(path.join(dir, 'dist', 'claude')); // last-ditch
}

launch(${JSON.stringify(entryFile)}, async (m) => ${call}).catch(() => { /* graft unavailable — no-op */ });
`;
}

export function statuslineShim(bakedDir: string): string { return shim('statusline.js', 'm.main()', bakedDir); }
export function hooksShim(bakedDir: string): string { return shim('hooks.js', 'm.main(process.argv[2])', bakedDir); }
