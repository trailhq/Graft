# Graft Architectural Memory & Execution Knowledge Base

## 1. System Overview & Core Principles
- **Project**: Graft (`@nanonets/graft`) — Open-source context layer for large codebases.
- **Purpose**: Turbocharges coding agents (Claude Code, Cursor, Codex, Gemini) by maintaining a local, regenerable cache of the codebase graph (`graft/`) as linked markdown files.
- **Core Architecture**: Zero-cost local codebase map via deterministic tree-sitter parsing across supported languages (TS/JS, Python, Go, Java, PHP, Swift, Kotlin, R). Git is the sync (`.claude/` wiring committed, `graft/` gitignored).

## 2. Deep Dive: PR 1 — AST-Differential Caching (`astCache.ts`)
- **Design Decisions**: Tracks AST signature hashes (`astHash`) to differentiate between non-structural changes (internal function bodies, comments, formatting) and structural changes (exported symbols, interfaces, function signatures).
- **Tree-Sitter Strategy**: Leverages tree-sitter queries to extract symbol boundaries and signatures, bypassing full re-indexing when structural AST remains identical.
- **Edge Cases & Limitations**: Comments or internal whitespace updates do not invalidate the AST signature cache, avoiding unnecessary graph rebuilds.

## 3. Deep Dive: PR 2 — Structural Graph Ranking (`graphrank.ts`)
- **Design Decisions**: Implements Graph-Walking Retrieval (GraphRank Expansion) via decayed 1-hop neighborhood expansion tracing adjacent `imports`, `calls`, `implements`, and `extends` edges.
- **Decay Factor Logic ($d = 0.35$)**: Structural decay factor $d = 0.35$ ensures that expanded neighbor files do not overpower exact query matches, blending direct term matches with topological graph relevance.
- **Symbol Crowding Mitigation**: File-level grouping and score caps prevent a single heavily commented file from crowding out other relevant results.

## 4. Deep Dive: PR 3 — Local SLM Provider Bridge (`localSLMBridge.ts`)
- **Design Decisions**: Native configuration support for local inference engines (Ollama, vLLM, LM Studio, LiteLLM) with automatic API key check bypass for local endpoints.
- **Endpoint Compatibility**: Standardized OpenAI-compatible chat completion endpoints (`/v1/chat/completions`) with structured Markdown concept node formatting (`graft/*.md`).
- **Auth Bypass Logic**: Automatically skips mandatory remote auth header validation when local loopback endpoints (`localhost`, `127.0.0.1`) are configured.

## 5. Deep Dive: PR 4 — Multi-Artifact Tree-Sitter Parsers (`multiArtifactParser.ts`)
- **Design Decisions**: Extends tree-sitter parser suite to ingest multi-artifact files including SQL schemas (`.sql`), deployment manifests (`.yaml`), and Markdown documentation (`.md`).
- **AST Schemas & Relational Edges**: Maps non-code artifacts into typed graph nodes (`database_schema`, `config_definition`, `architectural_decision`) connected via explicit `constrains` and `references` edges in `wiring.json`.

## 6. Execution Audit & Approach Validations
- **Repository Setup**: Successfully forked (`abhilash333naidu/Graft`), cloned (`~/Graft`), configured with upstream remote, dependencies installed (`npm install`), and verified with full test suite passing (1215 tests passed).
- **NotebookLM Integration**: Connected to Graft Deep Research notebook (`graft-context-graph-engine`).

