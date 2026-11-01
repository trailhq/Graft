# Trail-Code Fork — Semantic Search

This is a fork of [trailhq/Trail-Code](https://github.com/trailhq/Trail-Code) (base: v0.28.0).

## What this fork adds

### `graft_search_semantic` — vector search over your code

Find code by **meaning**, not just keywords. When `graft ask` returns weak results because the code uses different terms than your query, semantic search bridges the gap.

**How it works:** after `trail build --semantic`, each parsed symbol is embedded with `all-MiniLM-L6-v2` (local ONNX, no API key, no network) and stored in `graft/.cache/embeddings.db`. The MCP tool embeds your query and returns the closest symbols by cosine similarity.

**Workspace-aware:** works across multi-repo workspaces — results are labeled `[repo/]`.

**Incremental:** the index is hash-checked on each call; only re-embeds when the graph changes.

### Performance fix: `graft grep` O(n) instead of O(files×nodes)

Fixes [#702](https://github.com/trailhq/Trail-Code/issues/702) — `grepGraph` was O(files × nodes) due to `symbolsOf` rescanning all graph nodes per file. Pre-indexes nodes by path in a `WeakMap`, reducing to O(nodes) one-time build + O(1) per lookup. 43s → 1.6s on a 3,700-file repo.

## Differences from upstream

| | Upstream | This fork |
|---|---|---|
| Package name | `@nanonets/graft` | `@detacoop/trail-code` |
| Semantic search | ❌ | ✅ `graft_search_semantic` MCP tool |
| grep performance | O(files×nodes) | O(nodes) |
| Extra deps | — | `@huggingface/transformers`, `better-sqlite3`, `sqlite-vec` |

---

## Setup

### 1 — Install the fork

> **Note:** uninstall the upstream first if you have it, to avoid binary conflicts.
> ```bash
> npm uninstall -g @trailhq/trail-code
> ```

```bash
git clone https://github.com/jastorgaexterno/Trail-Code
cd Trail-Code
npm install --ignore-scripts   # skips tree-sitter-kotlin native C++ build (no Visual Studio needed)
npm run build                  # compile TypeScript → dist/
npm install -g .               # register trail and graft binaries globally
```

Verify:
```bash
trail --version   # should print 0.28.0-semantic.1
trail build --help | grep semantic   # should show --semantic flag
```

### 2 — Build the semantic index

Run this once per repo (or workspace). The first run downloads the embedding model (~87 MB, cached at `~/.cache/huggingface/transformers/`).

```bash
# Single repo
trail build --semantic /path/to/your/repo

# Multi-repo workspace (folder with multiple git repos inside)
trail build --semantic /path/to/your/workspace
```

Subsequent runs are fast — the index is hash-checked and only re-embeds when the code changes.

### 3 — Wire into Hermes

Add to `~/.hermes/config.yaml` under `mcp_servers:`:

```yaml
mcp_servers:
  trail:
    command: trail
    args:
      - mcp
      - /path/to/your/workspace   # e.g. C:/Users/jastorga/Desarrollo/default-core
    env:
      PYTHONUTF8: "1"
    enabled: true
```

After restarting Hermes, the following tools are available:
- `graft_find_code` — ranked lexical search
- `graft_trace_calls` — call graph traversal
- `graft_search_semantic` — **semantic vector search** ← new in this fork
- `graft_find_all`, `graft_file_api`, `graft_repo_map`, `graft_check_freshness`

### 4 — Use it

```
graft_search_semantic: { query: "session expiry handling", limit: 5 }
graft_search_semantic: { query: "manejo de errores de red", limit: 3 }
```

Use `graft_search_semantic` when:
- `graft_find_code` returns weak results because the code uses different terms
- You're searching by concept without knowing the symbol name

Use `graft_find_code` when you already know part of the name — it's faster.

---

## Upstream PRs

- Grep O(n) fix: [trailhq/Trail-Code#713](https://github.com/trailhq/Trail-Code/pull/713)
- Semantic search feature request: [trailhq/Trail-Code#712](https://github.com/trailhq/Trail-Code/issues/712)
