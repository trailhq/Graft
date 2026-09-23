# Graft Repository Setup - Findings

## Repository Overview
- **Upstream**: trailhq/Graft (forked from NanoNets/context-graph-engine)
- **Fork**: abhilash333naidu/Graft
- **Local Path**: ~/Graft
- **Language**: TypeScript (ESM, Node >=20)
- **Package**: @nanonets/graft@0.17.0

## Architecture Summary
Graft builds a repository's context graph as a folder of linked markdown files — a local, regenerable cache that every query keeps in sync with your code. Key components:

### Core Modules (src/)
- **engine.ts** - Main Graft class orchestrating the graph
- **cli.ts** - CLI commands: build, ask, check, viz, mcp, callers, skeleton, grep, map, init
- **graph/** - Graph building, loading, refresh, traversal, scopes, workspace federation
- **ask/** - Query engine with fusion ranking, file-aware selection, scope comparability
- **blast/** - Blast radius analysis (callers, diagrams, owners)
- **ingest/fs.ts** - Filesystem walking with Git awareness, skip dirs, size limits
- **context/** - Context nodes, checkpoints, savings calculation
- **ai/** - LLM providers (Anthropic, OpenAI, LiteLLM, OrcaRouter)
- **claude/** - Deep Claude Code integration (hooks, settings, session metrics)
- **hosts/** - Multi-agent host integration (Claude, Codex, Cursor, etc.)
- **mcp/** - MCP server with 6 tools
- **viz/** - Visualization (viewer, context graph, code graph)
- **telemetry/** - Anonymous opt-out telemetry

### Key Concepts
1. **Graph as files** - `graft/` directory is a local cache (like node_modules), regenerated on demand
2. **Git is the sync** - Commit the wiring (`.claude/`), each teammate runs `graft build` for their own graph
3. **Workspace federation** - Parent directory with ≥2 git children federates queries across children
4. **Tree-sitter parsing** - Multi-language support (TS/JS, Python, Go, Java, PHP, Swift, Kotlin, R)
5. **MCP integration** - 6 tools: find_code, check_freshness, trace_calls, find_all, repo_map, file_api

## Verification Results
- **Fork**: ✅ Created at https://github.com/abhilash333naidu/Graft
- **Clone**: ✅ Local at ~/Graft
- **Upstream remote**: ✅ Configured (origin + upstream)
- **Dependencies**: ✅ npm install successful (74 packages)
- **Tests**: ✅ 1215 pass, 5 skipped, 0 fail (79s duration)

## Next Steps (Phase 2)
1. Explore notebook training requirements - need clarification on:
   - What notebooks? (Jupyter? custom format?)
   - Training for what? (ML models? context embeddings? agent behavior?)
   - Target outcomes expected

2. Review existing notebook-related code in codebase (if any)

3. Define technical approach for notebook ingest pipeline