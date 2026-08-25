#!/usr/bin/env node
/**
 * `graft` CLI. Commands: build, ask, check, viz, mcp, callers, skeleton, grep,
 * map, init. Git is the sync: commit graft/ and a clone has the graph. A
 * workspace parent (≥2 git children) federates query commands across children.
 */
import "dotenv/config";
import { Command } from "commander";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Graft } from "./engine.js";
import { resolveConfig, type EngineConfig } from "./ai/providers.js";
import type { ProviderKind } from "./ai/llm/factory.js";
import { formatCheckReport } from "./context/check.js";
import { formatGraphCheckReport } from "./graph/check.js";
import { buildGraphIfMissing, runInit } from "./claude/init.js";
import { runHostsInit } from "./hosts/init.js";
import { hostIds } from "./hosts/registry.js";
import { contextDirFor } from "./context/node-file.js";
import { loadGraphCached } from "./graph/load.js";
import { ensureFreshChildren, ensureFreshGraph, refreshNote } from "./graph/refresh.js";
import { isWorkspaceBuildRoot, readWorkspace } from "./graph/workspace.js";
import { nearestGraftRoot } from "./graph/root.js";
import { unsupportedExtensions, supportedExtensions } from "./graph/source-files.js";
import { discoverWorkspaceChildren } from "./graph/scopes.js";
import {
  runWorkspaceAsk,
  runWorkspaceBuild,
  runWorkspaceCallers,
  runWorkspaceCheck,
  runWorkspaceGrep,
  runWorkspaceMap,
} from "./graph/workspace-cli.js";
import { formatInitEpilogue } from "./cli-epilogue.js";
import { planInit, selectedWrites } from "./hosts/plan.js";
import { formatNonInteractiveHelp, formatPlan, runPicker } from "./cli-picker.js";
import { homedir } from "node:os";
import { formatUpgradeReport, formatVersionReport, getNpmViewVersion, readCurrentVersion, runUpgrade } from "./cli-meta.js";
import { patchBuildConfig, type BuildConfig } from "./util/state.js";
import { formatUpdateNudge, maybeRefreshInBackground, readUpdateCache, refreshUpdateCache, writeStamp } from "./upkeep.js";
import {
  errorCode,
  filesBucket,
  durationBucket,
  formatDebug,
  formatStatus,
  firstRunNotice,
  isTrackedCommand,
  langsValue,
  offReason,
  maybeFlushInBackground,
  patchState,
  runFlush,
  track,
  trackFirstRunIfNew,
} from "./telemetry/index.js";

const program = new Command();
const currentVersion = readCurrentVersion(import.meta.url);

/**
 * What the `query` telemetry event will say, filled in by the command as it runs
 * and emitted once from the `postAction` hook below.
 *
 * A module-level slot rather than a threaded parameter because the repo root is
 * resolved deep inside each action (`queryRoot`) while the event is emitted
 * centrally — and because a command that calls `process.exit` should simply
 * report nothing, which falls out of never emitting until postAction.
 */
let queryNote: { repo?: string; hit?: "yes" | "no" } = {};

/** Record the repo a query ran against, and pass it straight through so call
 *  sites stay one line. */
function noteQuery(dir: string): string {
  queryNote.repo = dir;
  return dir;
}

/** Whether a query found anything. Only the commands that have a result count in
 *  hand call this; the property is simply absent for the others. */
function noteHit(found: boolean): void {
  queryNote.hit = found ? "yes" : "no";
}

program
  .name("graft")
  .description("Build a repo's context graph as linked markdown, and keep it in sync with the code.")
  .version(currentVersion, "-v, --version")
  .option("--dir <path>", "context graph directory (default: <repo>/graft)")
  .option("--provider <name>", "LLM wire format: openai | anthropic (env GRAFT_PROVIDER)")
  .option("--model <id>", "model id for the LLM pass (env GRAFT_MODEL)")
  .option("--api-key <key>", "provider API key (env GRAFT_API_KEY)")
  .option("--base-url <url>", "OpenAI-compatible endpoint URL (env GRAFT_BASE_URL)");

interface GlobalOpts {
  dir?: string;
  provider?: string;
  model?: string;
  apiKey?: string;
  baseUrl?: string;
}

/** Config drawn from the global CLI flags (env + defaults fill the rest). */
function cliConfig(): EngineConfig {
  const o = program.opts<GlobalOpts>();
  return {
    contextDir: o.dir,
    provider: o.provider as ProviderKind | undefined,
    model: o.model,
    apiKey: o.apiKey,
    baseUrl: o.baseUrl,
  };
}

const engineFrom = (): Graft => new Graft(cliConfig());

/**
 * Warn (never fail) when a user's `-e` extension has no parser, so it is never a silent
 * no-op — `graft build -e ".vue"` used to accept it, index nothing, and exit 0. The
 * supported set is listed so `-e` also answers "what is actually supported".
 */
function warnUnsupportedExtensions(exts?: string[]): void {
  if (!exts?.length) return;
  const bad = unsupportedExtensions(exts);
  if (bad.length === 0) return;
  for (const e of bad) {
    const shown = e.trim().startsWith(".") ? e.trim() : `.${e.trim()}`;
    console.error(`⚠ -e "${shown}": no parser registered for this extension — ignoring it.`);
  }
  console.error(`  supported: ${supportedExtensions().join(" ")}`);
}

/** Text for the omitted-`[dir]` case, shared by every query command's help. */
const DIR_ARG = ["[dir]", "repository root (default: nearest ancestor with a graft/ index)"] as const;

/**
 * The root a query runs against: the dir the user named, else the nearest
 * ancestor holding a graft index (`graph/root.ts`) so a shell or agent session
 * in a subdirectory still finds the graph. The walk is announced on stderr —
 * answering from an ancestor's graph must never be silent.
 */
function queryRoot(dir?: string): string {
  if (dir !== undefined) return resolve(dir);
  const { root, levels } = nearestGraftRoot(process.cwd(), program.opts<GlobalOpts>().dir);
  if (levels > 0) console.error(`[graft] no graft/ here — answering from ${root}/graft`);
  return root;
}

/**
 * Bring the graph up to date with the working tree before a query answers from it
 * — the same gate the MCP tools run (see `graph/refresh.ts`). Cheap when nothing
 * moved; a structural, $0 rebuild when it did. The note goes to stderr so `--json`
 * stdout stays machine-readable.
 */
async function refreshBefore(dir: string, opts: { refresh?: boolean }): Promise<void> {
  const globalDir = program.opts<GlobalOpts>().dir;
  const root = resolve(dir);
  const disabled = opts.refresh === false;
  const ws = readWorkspace(root, globalDir);
  const r = ws
    ? await ensureFreshChildren(root, ws.children, { contextDir: globalDir, disabled })
    : await ensureFreshGraph(root, { contextDir: globalDir, disabled });
  const note = refreshNote(r);
  if (note) console.error(note);
}

/** Attached to every query command: `--no-refresh` answers from the graph exactly
 * as it is on disk, no rebuild. */
const NO_REFRESH_FLAG = ["--no-refresh", "skip the freshness check — answer from the graph as-is"] as const;

const VIZ_TABS = ["context", "code", "outline"] as const;
type VizTab = (typeof VIZ_TABS)[number];

/**
 * `--tabs context,code` → the tabs to write into an exported page.
 *
 * An unknown name is a caller mistake worth failing on rather than silently
 * dropping: a page exported with a typo'd tab list would be missing a tab and
 * nothing would say why. Undefined means "all of them", which is the default the
 * exporter already applies.
 */
function parseTabs(raw: string | undefined): VizTab[] | undefined {
  if (raw === undefined) return undefined;
  const want = raw.split(",").map((t) => t.trim()).filter(Boolean);
  const bad = want.filter((t) => !VIZ_TABS.includes(t as VizTab));
  if (bad.length > 0 || want.length === 0) {
    console.error(`✗ --tabs takes a comma-separated subset of ${VIZ_TABS.join(", ")}${bad.length ? ` — got "${bad.join('", "')}"` : ""}`);
    process.exit(1);
  }
  return want as VizTab[];
}

/**
 * Commands that own the upgrade story themselves (`version`, `upgrade`) or must
 * not editorialize on stderr at startup (`mcp` runs its own upkeep at boot, and
 * `_update-check` IS the fetch).
 */
const UPKEEP_SKIP = new Set(["version", "upgrade", "_update-check", "mcp"]);

/**
 * Every other command: top up the cached registry answer in the background and,
 * if a newer graft is out, say so once on stderr. This is what makes the CLI the
 * cache filler for the hooks, which are not allowed to touch the network.
 */
program.hook("preAction", (_parent, action) => {
  if (UPKEEP_SKIP.has(action.name())) return;
  maybeRefreshInBackground();
  const nudge = formatUpdateNudge(currentVersion, readUpdateCache()?.latest);
  if (nudge) console.error(nudge);
  // Telemetry, in the order a user should experience it: disclose first, then
  // record, then (at most once a day, detached) send. Every step is a no-op in a
  // fork, in CI, under DO_NOT_TRACK, or after `graft telemetry disable`.
  const notice = firstRunNotice();
  if (notice) console.error(notice);
  trackFirstRunIfNew();
  maybeFlushInBackground();
});

/**
 * The `query` event, emitted after the command rather than before it, so it can
 * carry what the query actually did. A command that exits early via
 * `process.exit` never reaches here and is simply not counted — under-reporting
 * is the right failure mode for a metric.
 */
program.hook("postAction", (_parent, action) => {
  const name = action.name();
  if (!isTrackedCommand(name)) return;
  track("query", { command: name, surface: "cli", hit: queryNote.hit }, { repo: queryNote.repo });
});

// Hidden from --help: only ever spawned detached by maybeRefreshInBackground.
program
  .command("_update-check", { hidden: true })
  .description("internal: refresh the cached latest-version answer")
  .action(() => {
    refreshUpdateCache();
  });

// Hidden for the same reason as _update-check: only ever spawned detached, by
// maybeFlushInBackground. Running it by hand is harmless — it drains the queue.
program
  .command("_telemetry-flush", { hidden: true })
  .description("internal: POST the queued anonymous usage events")
  .action(async () => {
    await runFlush();
  });

program
  .command("telemetry")
  .description("Show, inspect, or turn off the anonymous usage stats (see TELEMETRY.md)")
  .argument("[action]", "status (default) | enable | disable | debug", "status")
  .action((action: string) => {
    switch (action) {
      case "status":
        console.log(formatStatus());
        return;
      case "enable":
        patchState({ enabled: true });
        console.log("telemetry: on — anonymous, aggregate-only. `graft telemetry status` for details.");
        return;
      case "disable":
        // Also stamp the notice as shown: someone who has just opted out should
        // not be told about telemetry again the next time they run a command.
        patchState({ enabled: false, noticeShownAt: new Date().toISOString() });
        console.log("telemetry: off. Nothing further will be recorded or sent.");
        return;
      case "debug":
        console.log(formatDebug());
        return;
      default:
        console.error(`✗ unknown action "${action}" — expected status, enable, disable, or debug`);
        process.exit(1);
    }
  });

program
  .command("version")
  .description("Print the installed version and the latest published on npm")
  .action(() => {
    const latest = getNpmViewVersion();
    console.log(formatVersionReport(currentVersion, latest));
  });

program
  .command("upgrade")
  .description("Upgrade the globally installed graft to the latest version on npm")
  .action(() => {
    const result = runUpgrade(import.meta.url);
    console.log(formatUpgradeReport(result));
    if (result.ran && !result.ok) process.exit(1);
  });

program
  .command("build")
  .description(
    "Build graft/ from your code — wiring graph + per-file cards ($0, no key). " +
      "Add --deep for the LLM concept map + per-symbol summaries/crux.",
  )
  .argument("[dir]", "repository root", ".")
  .option("--deep", "run the LLM pass: concept nodes (graft/*.md) + per-symbol summary/crux")
  .option("-e, --extensions <exts...>", 'code extensions to include (e.g. ".ts" ".py"); an extension with no parser is ignored with a warning that lists the supported set')
  .option("-j, --concurrency <n>", "files summarized in parallel during --deep (default 5)")
  .option("--no-reuse", "re-parse every file instead of replaying unchanged ones from the extraction cache")
  .option("--lsp", "add compiler-grade call edges via a language server if one is installed (opt-in, slower; e.g. rust-analyzer, clangd)")
  .option("--allow-partial", "with --deep: exit 0 even when some files' summaries failed (default: a degraded meaning tier exits 1)")
  .option(
    "--follow-submodules",
    "include initialized Git submodules recursively; persisted for later builds and automatic refreshes",
  )
  .option(
    "--no-follow-submodules",
    "exclude Git submodules; persisted for later builds and automatic refreshes (default)",
  )
  .option(
    "--include-dir <name>",
    "override SKIP_DIRS for this repo's walks — repeatable (e.g. --include-dir build --include-dir tools); " +
      "persisted, so a later build (and the hooks/refresh path) include it without the flag; dot-dirs are never overridable",
    (val: string, prev: string[]) => [...prev, val],
    [] as string[],
  )
  .action(async (
    dir: string,
    opts: {
      deep?: boolean;
      extensions?: string[];
      concurrency?: string;
      reuse?: boolean;
      lsp?: boolean;
      allowPartial?: boolean;
      includeDir?: string[];
      followSubmodules?: boolean;
    },
    command: Command,
  ) => {
    const buildStartedAt = Date.now();
    const concurrency = opts.concurrency ? Math.max(1, Number(opts.concurrency)) : undefined;
    if (opts.concurrency && !Number.isFinite(concurrency)) {
      console.error(`✗ --concurrency must be a number, got "${opts.concurrency}"`);
      process.exit(1);
    }
    warnUnsupportedExtensions(opts.extensions);
    // Persisted BEFORE the build itself runs, so this invocation's walks (and
    // every later no-flag build / hooks refresh) see it identically — the
    // walkDir call sites read it from state, not from a threaded option.
    const buildConfigPatch: BuildConfig = {};
    if (opts.includeDir && opts.includeDir.length > 0) {
      // --include-dir takes bare SKIP_DIRS-style directory NAMES (shouldSkipDir
      // compares a single path segment), never paths, and dot-dirs are never
      // overridable at all (see the option's own help text) — reject anything
      // else up front instead of silently persisting a value that can never
      // match a real directory name.
      for (const name of opts.includeDir) {
        if (name.startsWith(".")) {
          console.error(`✗ --include-dir "${name}": dot-directories are never overridable`);
          process.exit(1);
        }
        if (name.includes("/") || name.includes("\\")) {
          console.error(`✗ --include-dir "${name}": expected a bare directory name, not a path`);
          process.exit(1);
        }
      }
      buildConfigPatch.includeDirs = opts.includeDir;
    }
    const followSubmodulesWasExplicit = command.getOptionValueSource("followSubmodules") === "cli";
    if (followSubmodulesWasExplicit && typeof opts.followSubmodules === "boolean") {
      buildConfigPatch.followSubmodules = opts.followSubmodules;
    }
    if (Object.keys(buildConfigPatch).length > 0) {
      patchBuildConfig(resolve(dir), buildConfigPatch);
    }
    const engine = engineFrom();
    const fmt = (o: Record<string, number>) =>
      Object.entries(o)
        .sort((a, b) => b[1] - a[1])
        .map(([k, n]) => `${n} ${k}`)
        .join(", ");

    // --deep needs a key; without one, degrade to the $0 structural build.
    let deep = opts.deep;
    const resolved = resolveConfig(cliConfig());
    if (deep && !resolved.apiKey) {
      deep = false;
      console.error(
        "⚠ no API key set — falling back to the structural build (no LLM summaries).\n" +
          "  Set GRAFT_API_KEY (and GRAFT_PROVIDER / GRAFT_BASE_URL / GRAFT_MODEL for your\n" +
          "  provider) and re-run `graft build --deep` to add concept nodes and summaries.",
      );
    }
    if (deep && resolved.usedLegacyEnv) {
      console.error(
        "⚠ using OPENROUTER_API_KEY (deprecated) — prefer GRAFT_API_KEY + GRAFT_BASE_URL.",
      );
    }

    // Workspace parent: build each child into its OWN graft/ + a workspace index.
    const buildRoot = resolve(dir);
    const buildGlobalDir = program.opts<GlobalOpts>().dir;
    if (isWorkspaceBuildRoot(buildRoot, buildGlobalDir)) {
      await runWorkspaceBuild(buildRoot, {
        deep: !!deep,
        extensions: opts.extensions,
        concurrency,
        childConfig: cliConfig(),
        override: buildGlobalDir,
        includeDirs: opts.includeDir,
        followSubmodules: followSubmodulesWasExplicit ? opts.followSubmodules : undefined,
      });
      return;
    }

    // --deep: concept nodes first, then the wiring graph links cards up to them.
    let conceptErrors: string[] = [];
    let conceptFatal: string | undefined;
    if (deep) {
      const c = await engine.init(dir, {
        extensions: opts.extensions,
        onProgress: ({ phase, index, total, file }) =>
          process.stderr.write(
            `\r${phase === "summarize" ? "reading" : "writing"} concepts ${index + 1}/${total}: ${file.slice(0, 40).padEnd(40)}`,
          ),
      }).catch((err: unknown) => {
        // Only the stage and a code enum; the message stays on this machine.
        track("build_failed", { stage: "summarize", code: errorCode(err) }, { repo: buildRoot });
        throw err;
      });
      process.stderr.write("\n");
      console.log(
        `✓ concepts: ${c.nodes} nodes, ${c.links} links from ${c.files} files (${c.summarized} read, ${c.cached} cached)`,
      );
      for (const e of c.errors) console.error(`✗ ${e}`);
      conceptErrors = c.errors;
      conceptFatal = c.fatal;
    }

    // Wiring graph — always; LLM meaning only with --deep.
    const g = await engine.graph(dir, {
      llm: deep,
      concurrency,
      reuse: opts.reuse,
      lsp: opts.lsp,
      onProgress: ({ phase, index, total, file }) =>
        process.stderr.write(
          `\r${phase === "enrich" ? "summarizing" : "parsing"} ${index + 1}/${total}: ${file.slice(0, 50).padEnd(50)}`,
        ),
    }).catch((err: unknown) => {
      track("build_failed", { stage: "graph", code: errorCode(err) }, { repo: buildRoot });
      throw err;
    });
    process.stderr.write("\n");
    console.log(`✓ wiring: ${g.nodes} nodes (${fmt(g.byKind)}), ${g.edges} edges, ${g.cards} cards [${g.languages.join(", ")}]`);
    console.log(`  parsed: ${g.parsed} of ${g.files} files (${g.reused} replayed from cache)`);
    // Worth one line: this build started from a graph the user never built *here*.
    if (g.seededFrom) console.log(`  seeded: copied a starting graph from ${g.seededFrom} (git worktree)`);
    if (deep) {
      const m = g.meaning;
      console.log(`  meaning: ${m.computed} computed, ${m.cached} cached, ${m.stale} stale, ${m.pending} pending`);
    }
    console.log(`  → ${g.contextDir}`);
    // The activation event. Everything here is a bucket or a fixed label: repo
    // scale rather than a file count, a language set rather than file names.
    track(
      "build_completed",
      {
        files_bucket: filesBucket(g.files),
        langs: langsValue(g.languages),
        mode: deep ? "deep" : "fast",
        duration_bucket: durationBucket(Date.now() - buildStartedAt),
        incremental: String(g.reused > 0),
      },
      { repo: buildRoot },
    );
    for (const e of g.errors) console.error(`✗ ${e}`);

    const rel = relative(process.cwd(), g.contextDir) || "graft";
    console.log(`  ${rel}/ is git-ignored (added automatically) — a local cache; teammates run \`graft build\` to get their own.`);

    // #127: a --deep run whose LLM calls failed used to print the same success
    // footer and exit 0, so a quota-exhausted build looked identical to a clean
    // one and `graft check` still said "in sync" (it only ever checked Tier-1).
    // The structural graph IS still written and every successful summary is
    // cached, so this is a loud warning about a degraded tier, not a rollback.
    if (deep) {
      const m = g.meaning;
      const failed =
        m.failedFiles > 0 || m.fatal !== undefined || conceptErrors.length > 0 || conceptFatal !== undefined;
      if (failed) {
        const ready = m.computed + m.cached;
        const total = ready + m.stale + m.pending;
        const pct = total > 0 ? Math.round((ready / total) * 100) : 0;
        console.error("");
        console.error(`✗ the deep pass did not complete — the meaning tier is incomplete.`);
        if (conceptFatal) console.error(`  concepts: ${conceptFatal}`);
        if (m.fatal) console.error(`  summaries: ${m.fatal}`);
        if (m.failedFiles > 0) {
          const skipped = m.skippedFiles > 0 ? `, ${m.skippedFiles} never attempted` : "";
          console.error(`  ${m.failedFiles} file(s) failed to summarize${skipped}.`);
        }
        if (conceptErrors.length > 0) console.error(`  ${conceptErrors.length} concept-pass error(s).`);
        console.error(`  meaning coverage: ${ready}/${total} symbols (${pct}%).`);
        console.error(
          "  Nothing computed was lost: re-run `graft build --deep` to resume from what is cached.\n" +
            "  Pass --allow-partial to accept a degraded meaning tier and exit 0.",
        );
        if (!opts.allowPartial) process.exitCode = 1;
      }
    }
  });

program
  .command("ask")
  .description("Query the graft/ graph — returns ranked nodes + exact file:line, routed to prose or wiring ($0, no key)")
  .argument("<query>", "what you want to understand, in plain words")
  .argument(...DIR_ARG)
  .option("-n, --limit <n>", "max results", "8")
  .option("--source", "inline the source at each file:line hit (retriever mode — the pack IS the answer, no need to re-open files)")
  .option("--full", "with --source: inline whole definition spans instead of the default ≤8-line crux excerpts")
  .option("--in <path>", "narrow to nodes under this path prefix, filtered before scoring (segment-aware, like scopeOf)")
  .option("--json", "output the result as JSON")
  .option("--no-graph-rank", "rank by lexical relevance only, without the graph-connectivity re-rank (ablation/eval)")
  .option(...NO_REFRESH_FLAG)
  .action(async (query: string, dirArg: string | undefined, opts: { limit: string; source?: boolean; full?: boolean; in?: string; json?: boolean; refresh?: boolean; graphRank?: boolean }) => {
    const dir = noteQuery(queryRoot(dirArg));
    await refreshBefore(dir, opts);
    const askGlobalDir = program.opts<GlobalOpts>().dir;
    if (readWorkspace(dir, askGlobalDir)) {
      runWorkspaceAsk(dir, askGlobalDir, query, {
        limit: Number(opts.limit), source: opts.source, full: opts.full, in: opts.in, json: opts.json,
      });
      return;
    }
    const engine = engineFrom();
    let r;
    try {
      r = engine.ask(dir, query, { limit: Number(opts.limit), source: opts.source, full: opts.full, in: opts.in, graphRank: opts.graphRank });
    } catch (err) {
      console.error(`✗ ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
      return;
    }
    noteHit(r.hits.length > 0);
    if (opts.json) {
      console.log(JSON.stringify(r, null, 2));
    } else {
      const { formatAsk } = await import("./ask/ask.js");
      process.stdout.write(formatAsk(r));
    }
  });

program
  .command("skeleton")
  .description("Signatures-only view of one file from the wiring graph — the cheapest way to see a file's API surface")
  .argument("<file>", "repo-relative path (or unique basename) of the file")
  .argument(...DIR_ARG)
  .option("--json", "output the result as JSON")
  .option(...NO_REFRESH_FLAG)
  .action(async (file: string, dirArg: string | undefined, opts: { json?: boolean; refresh?: boolean }) => {
    const dir = noteQuery(queryRoot(dirArg));
    await refreshBefore(dir, opts);
    const { skeleton, formatSkeleton } = await import("./ask/ask.js");
    const globalOpts = program.opts<{ dir?: string }>();
    const r = skeleton(dir, file, { contextDir: globalOpts.dir });
    if (opts.json) console.log(JSON.stringify(r, null, 2));
    else process.stdout.write(formatSkeleton(r));
  });

program
  .command("check")
  .description("Fail if graft/ is stale relative to the code (for CI)")
  .argument(...DIR_ARG)
  .option("-e, --extensions <exts...>", "code extensions to include")
  .option("--json", "output the drift as JSON")
  .action(async (dirArg: string | undefined, opts: { extensions?: string[]; json?: boolean }) => {
    warnUnsupportedExtensions(opts.extensions);
    const dir = noteQuery(queryRoot(dirArg));
    const checkGlobalDir = program.opts<GlobalOpts>().dir;
    if (readWorkspace(dir, checkGlobalDir)) {
      await runWorkspaceCheck(dir, checkGlobalDir);
      return;
    }
    const engine = engineFrom();
    const r = engine.check(dir, { extensions: opts.extensions });
    const g = await engine.checkGraph(dir); // graph.json is only judged when it exists

    // A layer that IS present must be in sync; a never-built layer (keyless
    // build skips the markdown layer) is informational, not a failure.
    const bothMissing = r.missing && g.missing;
    const markdownFail = !r.missing && !r.ok;
    const wiringFail = !g.missing && !g.ok;

    if (opts.json) {
      console.log(JSON.stringify({ context: r, graph: g.missing ? null : g }, null, 2));
    } else if (bothMissing) {
      console.log("graft check: NO GRAPH\n\nNo graft/ graph found. Run `graft build` first.");
    } else {
      if (r.missing) {
        console.log(
          "deep layer: not built (run `graft build --deep` for concept nodes) — wiring graph is the source of truth",
        );
      } else {
        console.log(formatCheckReport(r));
      }
      if (!g.missing) console.log("\n" + formatGraphCheckReport(g));
    }

    if (bothMissing || markdownFail || wiringFail) process.exit(1);
  });

program
  .command("viz")
  .description("Serve an interactive visualization of the context graph (and graph.json when present)")
  .argument(...DIR_ARG)
  .option("-p, --port <port>", "port to serve on", "4400")
  .option("--no-open", "don't open the browser")
  .option("--export <dir>", "write one self-contained index.html instead of serving (for CI, GitHub Pages, or a build artifact)")
  .option("--title <text>", "subtitle shown beside the repo name in an exported page (e.g. \"PR #151\")")
  .option("--tabs <list>", "tabs the exported page offers, comma separated: context,code,outline (default: all three)")
  .action(async (dirArg: string | undefined, opts: { port: string; open: boolean; export?: string; title?: string; tabs?: string }) => {
    // Flags are checked before the repository is: a typo'd `--tabs` is a mistake
    // in the command the caller just typed, and telling them to go build an index
    // first sends them off to fix the wrong thing.
    const tabs = parseTabs(opts.tabs);
    const dir = noteQuery(queryRoot(dirArg));
    const { existsSync } = await import("node:fs");
    const { resolve, basename } = await import("node:path");
    const { spawn } = await import("node:child_process");
    const { fileURLToPath } = await import("node:url");
    const { contextDirFor } = await import("./context/node-file.js");
    const { startVizServer } = await import("./viz/serve.js");

    const root = resolve(dir);
    const globalOpts = program.opts<{ dir?: string }>();
    const contextDir = contextDirFor(root, globalOpts.dir);
    if (!existsSync(contextDir)) {
      console.error(`✗ no context graph at ${contextDir} — run \`graft build --deep\` first`);
      process.exit(1);
    }
    const viewerDir = fileURLToPath(new URL("./viewer/", import.meta.url)); // prebuilt

    if (opts.export) {
      const { exportViz } = await import("./viz/export.js");
      const out = exportViz({
        contextDir,
        viewerDir,
        outDir: resolve(opts.export),
        repoName: basename(root),
        subtitle: opts.title,
        tabs,
      });
      const kb = Math.round(out.bytes / 1024);
      console.log(
        `graft viz → ${out.file} (${kb} kB, ${out.contextNodes} concept nodes, ${out.codeNodes} code nodes)`,
      );
      return;
    }

    const srv = await startVizServer({
      contextDir,
      viewerDir,
      port: Number(opts.port),
      repoName: basename(root),
    });
    console.log(`graft viz → ${srv.url}  (ctrl-c to stop)`);
    if (opts.open) {
      const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
      spawn(opener, [srv.url], { stdio: "ignore", detached: true, shell: process.platform === "win32" }).unref();
    }
  });

program
  .command("mcp")
  .description("Serve the graph over MCP (stdio) — exposes graft_find_code, graft_trace_calls, graft_find_all, graft_file_api, graft_repo_map and graft_check_freshness as tools")
  .argument(...DIR_ARG)
  .action(async (dirArg: string | undefined) => {
    const dir = noteQuery(queryRoot(dirArg));
    const { startMcpServer } = await import("./mcp/server.js");
    const globalOpts = program.opts<{ dir?: string }>();
    startMcpServer(dir, globalOpts.dir, currentVersion);
  });

program
  .command("callers")
  .description(
    "Who calls/references a symbol ($0, no LLM). --direction out gives callees (what it calls); --depth N (or all) walks transitively for full blast radius",
  )
  .argument("<symbol>", "bare name, qualified (Class.method), or package-qualified (pkg.Fn)")
  .argument(...DIR_ARG)
  .option("--direction <in|out>", 'edge direction: "in" = callers (default), "out" = callees')
  .option("-d, --depth <n>", 'walk transitively up to N hops for blast radius, or "all" for the full connected closure (default 1)')
  .option("--in <path>", "narrow matches to nodes at or under this path prefix")
  .option("--json", "output as JSON")
  .option(...NO_REFRESH_FLAG)
  .action(
    async (
      symbol: string,
      dirArg: string | undefined,
      opts: { direction?: string; depth?: string; in?: string; json?: boolean; refresh?: boolean },
    ) => {
      const dir = noteQuery(queryRoot(dirArg));
      await refreshBefore(dir, opts);
      const globalOpts = program.opts<{ dir?: string }>();
      if (!opts.json && readWorkspace(dir, globalOpts.dir)) {
        runWorkspaceCallers(dir, globalOpts.dir, symbol, {
          direction: opts.direction === "out" ? "out" : "in",
          depth: opts.depth
            ? (/^(all|full|max)$/i.test(opts.depth) ? Number.POSITIVE_INFINITY : Number(opts.depth))
            : undefined,
          in: opts.in,
        });
        return;
      }
      const { runCallersCommand } = await import("./graph/traverse-cli.js");
      runCallersCommand(symbol, dir, {
        direction: opts.direction,
        depth: opts.depth,
        in: opts.in,
        json: opts.json,
        globalDir: globalOpts.dir,
      });
    },
  );

program
  .command("blast")
  .description(
    "Blast radius of a diff: what depends on the lines this change touched ($0, no LLM). " +
      "Built for CI — `--format markdown` is a PR comment with a Mermaid diagram.",
  )
  .argument(...DIR_ARG)
  .option("--base <ref>", "diff against this ref's merge base with HEAD (e.g. origin/main); default: the working tree vs HEAD")
  .option("-d, --depth <n>", 'hops to walk over incoming edges, or "all" for the full closure (default 2)')
  .option("--format <fmt>", "text (default) | markdown | mermaid | json")
  .option("--name", "name the affected areas with one cached LLM call (needs GRAFT_API_KEY); without it, areas are named after their hub symbol")
  .option("--export-viz <dir>", "also write the interactive page for this radius (one self-contained index.html — for CI, GitHub Pages, or an artifact)")
  .option("--title <text>", "subtitle beside the repo name on the exported page (e.g. \"PR #171\")")
  .option(...NO_REFRESH_FLAG)
  .action(async (dirArg: string | undefined, opts: { base?: string; depth?: string; format?: string; name?: boolean; exportViz?: string; title?: string; refresh?: boolean }) => {
    const dir = noteQuery(queryRoot(dirArg));
    await refreshBefore(dir, opts);
    const { runBlastCommand } = await import("./blast/blast-cli.js");
    await runBlastCommand(dir, {
      base: opts.base,
      depth: opts.depth,
      format: opts.format,
      name: opts.name,
      exportViz: opts.exportViz,
      title: opts.title,
      globalDir: program.opts<GlobalOpts>().dir,
    });
  });

program
  .command("grep")
  .description("Regex search over indexed files, hits grouped by enclosing symbol and ranked by coupling ($0, no LLM)")
  .argument("<pattern>", "regex pattern (or literal string with --fixed)")
  .argument(...DIR_ARG)
  .option("-i, --ignore-case", "case-insensitive match")
  .option("--fixed", "treat pattern as a literal string, not a regex")
  .option("--in <path>", "narrow to files at or under this path prefix")
  .option("--json", "output as JSON")
  .option(...NO_REFRESH_FLAG)
  .action(
    async (
      pattern: string,
      dirArg: string | undefined,
      opts: { ignoreCase?: boolean; fixed?: boolean; in?: string; json?: boolean; refresh?: boolean },
    ) => {
      const dir = noteQuery(queryRoot(dirArg));
      await refreshBefore(dir, opts);
      const globalOpts = program.opts<{ dir?: string }>();
      if (readWorkspace(dir, globalOpts.dir)) {
        runWorkspaceGrep(dir, globalOpts.dir, pattern, {
          ignoreCase: opts.ignoreCase, fixed: opts.fixed, json: opts.json,
        });
        return;
      }
      const { runGrepCommand } = await import("./search/grep-cli.js");
      runGrepCommand(pattern, dir, {
        ignoreCase: opts.ignoreCase,
        fixed: opts.fixed,
        in: opts.in,
        json: opts.json,
        globalDir: globalOpts.dir,
      });
    },
  );

program
  .command("map")
  .description(
    "Token-budgeted repo orientation — directory clusters, per-directory hubs, and global hotspots from the wiring graph ($0, no LLM)",
  )
  .argument(...DIR_ARG)
  .option("--max-dirs <n>", "max directory entries shown, rest counted into dropped (default 16)")
  .option("--json", "output as JSON")
  .option(...NO_REFRESH_FLAG)
  .action(async (dirArg: string | undefined, opts: { json?: boolean; maxDirs?: string; refresh?: boolean }) => {
    const dir = noteQuery(queryRoot(dirArg));
    const root = resolve(dir);
    const globalOpts = program.opts<{ dir?: string }>();
    let maxDirsW: number | undefined;
    if (opts.maxDirs !== undefined) {
      const n = parseInt(opts.maxDirs, 10);
      if (!Number.isFinite(n) || n <= 0) {
        console.error(`✗ --max-dirs must be a positive integer, got "${opts.maxDirs}"`);
        process.exit(1);
        return;
      }
      maxDirsW = n;
    }
    await refreshBefore(dir, opts); // after arg validation: a bad flag shouldn't cost a rebuild
    if (!opts.json && readWorkspace(root, globalOpts.dir)) {
      runWorkspaceMap(root, globalOpts.dir, { maxDirs: maxDirsW });
      return;
    }
    const { buildRepoMap, formatRepoMap } = await import("./graph/map.js");
    const contextDir = contextDirFor(root, globalOpts.dir);
    const graph = loadGraphCached(contextDir);
    if (!graph) {
      console.error("✗ no graph — run graft build first");
      process.exit(1);
      return;
    }
    const map = buildRepoMap(graph, { maxDirs: maxDirsW });
    if (opts.json) {
      console.log(JSON.stringify(map, null, 2));
      return;
    }
    process.stdout.write(formatRepoMap(map));
  });

program
  .command("init")
  .description("Wire Graft into the AI coding agents used with this repo (instruction files + MCP server; full hooks + statusline + MCP for Claude Code)")
  .argument("[dir]", "target repo directory", ".")
  .option("--no-build", "skip building the graph (wire files only)")
  .option("--agents <ids...>", `only these agents (${hostIds().join(", ")}, claude)`)
  .option("--all-agents", "write instruction files for every known agent, detected or not")
  .option("--no-agents", "Claude Code wiring only; skip other agents")
  .option("--list-agents", "list known agent ids and exit")
  .option("--no-mcp", "skip MCP server registration for other agents")
  .option("--no-hooks", "skip hook installation for other agents")
  .option("--dry-run", "print every file init would touch, then exit without writing")
  .option("-y, --yes", "skip the picker and wire every detected agent (the pre-0.8 default)")
  .option("--no-global", "skip writes outside this repo (the ~/.codex/ config + hooks)")
  .action(async (dir: string, opts: { build?: boolean; agents?: string[]; allAgents?: boolean; listAgents?: boolean; mcp?: boolean; hooks?: boolean; dryRun?: boolean; yes?: boolean; global?: boolean }) => {
    if (opts.listAgents) {
      for (const id of [...hostIds(), "claude"]) console.log(id);
      return;
    }
    const repo = resolve(dir);
    const explicit = Array.isArray(opts.agents) ? opts.agents : undefined;

    if (explicit) {
      const validIds = [...hostIds(), "claude"];
      const unknown = explicit.filter((id) => !validIds.includes(id));
      if (unknown.length) {
        console.error(`✗ unknown agent id(s): ${unknown.join(", ")} — valid: ${validIds.join(", ")}`);
        process.exit(1);
      }
    }

    // Which agents to wire, decided before anything is written. Explicit flags
    // win; otherwise prompt on a TTY, and on a pipe write nothing rather than
    // guessing (pre-0.8 this silently wired every agent the machine had ever
    // installed — see --yes to get that back).
    const home = homedir();
    const plan = planInit(repo, { home });
    const detectedIds = plan.filter((p) => p.detected).map((p) => p.id);
    const noAgents = (opts as { agents?: unknown }).agents === false;

    let ids: string[];
    // The consent answer from the picker. Undefined everywhere else — a scripted
    // or flag-driven init never asked, so it must not silently answer.
    let consent: boolean | undefined;
    if (explicit) ids = explicit;
    else if (opts.allAgents) ids = plan.map((p) => p.id);
    else if (noAgents) ids = ["claude"];
    else if (opts.yes || opts.dryRun) ids = detectedIds;
    else if (process.stdin.isTTY && process.stderr.isTTY) {
      // Only offer the row when telemetry could actually run. `disabled` still
      // counts: someone who turned it off should be able to turn it back on here.
      const reason = offReason();
      const picked = await runPicker(plan, repo, home, {
        offerTelemetry: reason === null || reason === "disabled",
      });
      if (picked === null) {
        console.error("· cancelled — nothing written");
        return;
      }
      ids = picked.hosts;
      consent = picked.telemetry;
    } else {
      console.error(formatNonInteractiveHelp(detectedIds));
      return;
    }

    // The picker's answer, recorded before anything is wired: a user who
    // unchecked the row must not have this run's init_completed sent.
    if (consent !== undefined) {
      patchState({ enabled: consent, noticeShownAt: new Date().toISOString() });
    }

    // Workspace parent: every child repo gets its OWN wiring too. A session
    // opens at a repo root, not at the parent, and reads `.claude/` from there —
    // wiring only the parent leaves each child with no skill, hooks, or MCP.
    // The parent's own wiring stays (queries there federate across children).
    const children = isWorkspaceBuildRoot(repo, program.opts<GlobalOpts>().dir)
      ? discoverWorkspaceChildren(repo)
      : [];
    // Parent FIRST: its build is the workspace build, which builds every child's
    // graph, so each child's own `buildGraphIfMissing` then finds one and no-ops.
    const targets = [repo, ...children.map((c) => join(repo, c))];

    if (opts.dryRun) {
      console.error(formatPlan(plan, ids, repo, home));
      for (const child of children)
        console.error(`\n— ${child}/ (workspace child)\n` + formatPlan(planInit(join(repo, child), { home }), ids, join(repo, child), home));
      return;
    }
    if (ids.length === 0) {
      console.error("· no agents selected — nothing written");
      return;
    }

    const wantClaude = ids.includes("claude");
    const cliPath = fileURLToPath(import.meta.url);

    if (children.length)
      console.error(`· workspace: wiring ${repo} and ${children.length} child repo(s) — ${children.join(", ")}`);

    for (const target of targets) {
      if (target !== repo) console.error(`\n— ${relative(repo, target)}/`);
      wireTarget(target, ids, { home, cliPath, plan, opts, wantClaude });
    }

    // One epilogue for the whole run. A workspace parent holds no nodes of its
    // own, so the totals come from the children — the graph the user actually got.
    const globalDir = program.opts<GlobalOpts>().dir;
    const graphs = (children.length ? children.map((c) => join(repo, c)) : [repo])
      .map((d) => loadGraphCached(contextDirFor(d, children.length ? undefined : globalDir)))
      .filter((g): g is NonNullable<typeof g> => g !== null);
    console.error(
      "\n" +
        formatInitEpilogue({
          graphBuilt: graphs.length > 0,
          nodes: graphs.reduce((n, g) => n + g.meta.nodeCount, 0),
          edges: graphs.reduce((n, g) => n + g.meta.edgeCount, 0),
        }),
    );
    // Sorted so `claude,cursor` and `cursor,claude` aggregate as one value.
    track(
      "init_completed",
      { agents: [...ids].sort().join(","), consent: consent === undefined ? "unasked" : String(consent) },
      { repo },
    );
  });

/** One repo's worth of `init` writes — the parent, then each workspace child. */
function wireTarget(
  repo: string,
  ids: string[],
  ctx: {
    home: string;
    cliPath: string;
    plan: ReturnType<typeof planInit>;
    wantClaude: boolean;
    opts: { build?: boolean; mcp?: boolean; hooks?: boolean; global?: boolean };
  },
): void {
    const { home, cliPath, plan, wantClaude, opts } = ctx;

    if (wantClaude) {
      const res = runInit(repo, { build: opts.build, cliPath });
      console.error(`✓ wrote ${res.settingsPath}`);
      for (const s of res.shims) console.error(`✓ wrote ${s}`);
      console.error(`✓ wrote ${res.skill}`);
      if (res.mcp.action === "skipped-unparseable")
        console.error(`⚠ .mcp.json: ${res.mcp.path} left unchanged (not valid JSON) — add the graft server manually`);
      else if (res.mcp.action === "unchanged")
        console.error(`· mcp claude: ${res.mcp.path} (already registered)`);
      else
        console.error(`✓ mcp claude: ${res.mcp.path} (${res.mcp.action}) — restart Claude Code to load the graft MCP server`);
      console.error(res.built ? "✓ built the graph (graft build)" : "· skipped graph build");
      for (const w of res.warnings) console.error(`⚠ ${w}`);
    }

    // `ids` is already resolved, so hosts init is always driven by an explicit
    // list — never by its own detection fallback.
    const others = ids.filter((id) => id !== "claude");
    if (others.length > 0) {
      const r = runHostsInit(repo, {
        agents: others,
        home,
        mcp: opts.mcp,
        hooks: opts.hooks,
        global: opts.global,
      });
      for (const w of r.written) console.error(`✓ ${w.id}: ${w.path} (${w.action})`);
      for (const m of r.mcp) console.error(`✓ mcp ${m.id}: ${m.path} (${m.action})`);
      for (const h of r.hooks) console.error(`✓ hook ${h.id}: ${h.path} (${h.action})`);
      // Only worth saying when there was actually something out-of-repo to skip.
      if (opts.global === false && selectedWrites(plan, ids).some((w) => w.scope === "global"))
        console.error("· skipped out-of-repo writes (--no-global)");
    }

    // Record WHICH graft wrote this repo's agent files, and under which flags.
    // Every entry point compares this against the running binary and re-writes
    // them on a mismatch, so an `npm i -g` upgrade reaches the hooks/skill/rules
    // too — not just the binary. The flags ride along so a refresh replays the
    // user's choices (notably --no-global) instead of overriding them.
    writeStamp(repo, currentVersion, ids, {
      global: opts.global !== false,
      mcp: opts.mcp !== false,
      hooks: opts.hooks !== false,
    });

    // Every host's wiring points at graft/, so the graph is built whatever was
    // selected — not only when Claude Code is in the list (runInit does its own).
    if (!wantClaude) {
      console.error(
        buildGraphIfMissing(repo, { build: opts.build, cliPath })
          ? "✓ built the graph (graft build)"
          : "· skipped graph build",
      );
    }

}

program.parseAsync().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
