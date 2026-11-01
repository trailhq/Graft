/**
 * Semantic search over the code graph using @huggingface/transformers embeddings
 * and sqlite-vec for approximate nearest-neighbour retrieval.
 *
 * Spike 003 — Trail-Code fork integration.
 * Validated building blocks: Spike 001 (embeddings) + Spike 002 (sqlite-vec).
 */
import { createRequire } from 'node:module';
import { mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash } from 'node:crypto';
import type { NodeV1 } from '../graph/types.js';

// Use createRequire so CJS native modules load cleanly from this ESM file.
const _require = createRequire(import.meta.url);

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface SemanticHit {
  node_id: string;
  file_path: string;
  symbol: string;
  score: number;  // cosine similarity ∈ [-1, 1], higher is better
  snippet: string;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/** Normalise a Float32Array to unit length (required for cosine sim via L2). */
function normalize(vec: Float32Array): Float32Array {
  let sum = 0;
  for (const v of vec) sum += v * v;
  const norm = Math.sqrt(sum);
  if (norm === 0) return vec;
  const out = new Float32Array(vec.length);
  for (let i = 0; i < vec.length; i++) out[i] = vec[i]! / norm;
  return out;
}

/** Convert Float32Array → Buffer so better-sqlite3 accepts it as a blob. */
function vecToBuffer(arr: Float32Array): Buffer {
  return Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength);
}

// Module-level pipeline cache — one warm-up per process.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _extractor: any = null;

// Test-only override: replaces the real pipeline with a fake embedder.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _testEmbedder: ((text: string) => Float32Array) | null = null;

/**
 * Inject a fake embedder for tests — bypasses the 87 MB model download.
 * Call with `null` to restore the real pipeline.
 */
export function _setEmbedderForTest(fn: ((text: string) => Float32Array) | null): void {
  _testEmbedder = fn;
  // Also reset the cached extractor so it re-evaluates on the next call.
  _extractor = null;
}

async function getExtractor() {
  if (_testEmbedder) return _testEmbedder;
  if (_extractor) return _extractor;
  // Dynamic import keeps @huggingface/transformers tree-shakeable and avoids
  // loading ONNX during non-semantic code paths.
  const { pipeline, env } = await import('@huggingface/transformers');
  // Point the model cache at a stable location outside node_modules so it
  // survives npm ci / reinstalls (matches Spike 001 recommendation).
  const home = process.env['USERPROFILE'] ?? process.env['HOME'] ?? '.';
  env.cacheDir = `${home}/.cache/huggingface/transformers`;
  _extractor = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', { dtype: 'fp32' });
  return _extractor;
}

/** Embed a batch of texts → unit-normalised 384-dim float32 vectors. */
async function embedTexts(texts: string[]): Promise<Float32Array[]> {
  const extractor = await getExtractor();
  const results: Float32Array[] = [];
  for (const text of texts) {
    if (_testEmbedder) {
      // Test path: call the fake embedder directly and normalize.
      results.push(normalize((_testEmbedder)(text)));
    } else {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const output: any = await (extractor as any)(text, { pooling: 'mean', normalize: false });
      results.push(normalize(output.data as Float32Array));
    }
  }
  return results;
}

/** Open (or create) the SQLite db file and load the sqlite-vec extension. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function openDb(dbPath: string): any {
  mkdirSync(dirname(dbPath), { recursive: true });
  const Database = _require('better-sqlite3');
  const sqliteVec = _require('sqlite-vec') as { load(db: unknown): void };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = new (Database as any)(dbPath);
  sqliteVec.load(db);
  return db;
}

/** Idempotent schema setup (IF NOT EXISTS on every statement). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function initSchema(db: any): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS embed_nodes (
      rowid  INTEGER PRIMARY KEY,
      node_id   TEXT NOT NULL,
      file_path TEXT NOT NULL,
      symbol    TEXT NOT NULL,
      snippet   TEXT NOT NULL,
      body_hash TEXT
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS vss_nodes
    USING vec0(embedding float[384]);
    CREATE TABLE IF NOT EXISTS embed_meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
  // Migrate older DBs that lack body_hash column (ALTER TABLE is safe if column exists).
  try { db.exec(`ALTER TABLE embed_nodes ADD COLUMN body_hash TEXT`); } catch { /* already exists */ }
}

/** Compute a stable SHA-256 hash over all node IDs (sorted). */
function graphHash(nodes: NodeV1[]): string {
  const sorted = nodes.map(n => n.id).sort().join(',');
  return createHash('sha256').update(sorted).digest('hex');
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Embed all nodes in `nodes` and store them in the sqlite-vec database at
 * `dbPath`. Idempotent: if the DB already contains rows, the function returns
 * immediately without re-embedding.
 *
 * Called from the `graft_search_semantic` MCP tool handler (and optionally
 * from the build pipeline) to pre-populate the vector store.
 */
/**
 * Embed nodes and store them in the sqlite-vec database at `dbPath`.
 *
 * Incremental: compares each node's `body_hash` against what is already stored.
 * Only new or changed nodes are re-embedded; deleted nodes are removed.
 * Unchanged nodes are left untouched, making repeated calls cheap.
 */
export async function embedNodes(nodes: NodeV1[], dbPath: string): Promise<void> {
  const db = openDb(dbPath);
  initSchema(db);

  // Guard: nothing to embed — skip silently (0 nodes is valid for .md-only repos
  // that haven't enabled --include-md, or empty workspace children like openspec/).
  if (nodes.length === 0) {
    db.close();
    return;
  }

  const currentHash = graphHash(nodes);

  // Fast path: graph hash unchanged → index is fresh.
  const stored = db.prepare(
    "SELECT value FROM embed_meta WHERE key = 'graph_hash'"
  ).get() as { value: string } | undefined;

  if (stored?.value === currentHash) {
    const { c } = db.prepare('SELECT COUNT(*) AS c FROM embed_nodes').get() as { c: number };
    process.stderr.write(`[semantic] ${c} embeddings already in DB, fresh (hash match) — skipping re-embed\n`);
    db.close();
    return;
  }

  // Incremental path: compute per-node diff using body_hash.
  const existingRows = db.prepare(
    'SELECT node_id, body_hash FROM embed_nodes'
  ).all() as Array<{ node_id: string; body_hash: string | null }>;

  const existingMap = new Map(existingRows.map(r => [r.node_id, r.body_hash ?? '']));
  const incomingSet = new Set(nodes.map(n => n.id));

  // Nodes to remove: in DB but not in the new graph.
  const toDelete = existingRows.filter(r => !incomingSet.has(r.node_id)).map(r => r.node_id);

  // Nodes to add or update: new or body_hash changed.
  const toEmbed = nodes.filter(n => {
    const nodeHash = n.body_hash ?? n.id;
    return existingMap.get(n.id) !== nodeHash;
  });

  const added = toEmbed.filter(n => !existingMap.has(n.id)).length;
  const updated = toEmbed.length - added;

  process.stderr.write(
    `[semantic] incremental update — +${added} new, ~${updated} changed, -${toDelete.length} removed` +
    ` of ${nodes.length} total\n`
  );

  // Delete removed nodes.
  if (toDelete.length > 0) {
    const delMeta = db.prepare('DELETE FROM embed_nodes WHERE node_id = ?');
    const delVec = db.prepare('DELETE FROM vss_nodes WHERE rowid = (SELECT rowid FROM embed_nodes WHERE node_id = ?)');
    const delBatch = db.transaction(() => {
      for (const id of toDelete) {
        delVec.run(id);
        delMeta.run(id);
      }
    });
    delBatch();
  }

  // Embed and insert/update changed nodes.
  if (toEmbed.length > 0) {
    const texts = toEmbed.map(n =>
      [n.id, n.signature ?? '', n.body_text ?? ''].filter(Boolean).join(' ')
    );
    const vecs = await embedTexts(texts);

    const { maxId } = db.prepare('SELECT COALESCE(MAX(rowid), 0) AS maxId FROM embed_nodes').get() as { maxId: number };
    let nextRowid = maxId + 1;

    // Regular table: UPSERT ok.
    const upsertMeta = db.prepare(`
      INSERT INTO embed_nodes (rowid, node_id, file_path, symbol, snippet, body_hash)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(rowid) DO UPDATE SET
        node_id = excluded.node_id,
        file_path = excluded.file_path,
        symbol = excluded.symbol,
        snippet = excluded.snippet,
        body_hash = excluded.body_hash
    `);
    // Virtual table (sqlite-vec): no UPSERT support → DELETE then INSERT.
    const deleteVec = db.prepare('DELETE FROM vss_nodes WHERE rowid = ?');
    const insertVec = db.prepare('INSERT INTO vss_nodes (rowid, embedding) VALUES (?, ?)');
    const getRowid = db.prepare('SELECT rowid FROM embed_nodes WHERE node_id = ?');

    const upsertBatch = db.transaction(() => {
      for (let i = 0; i < toEmbed.length; i++) {
        const n = toEmbed[i]!;
        const v = vecs[i]!;
        const nodeHash = n.body_hash ?? n.id;
        const snippet = n.summary ?? n.signature ?? n.id;

        const existing = getRowid.get(n.id) as { rowid: number } | undefined;
        const rowid = existing ? BigInt(existing.rowid) : BigInt(nextRowid++);

        // For updated nodes: remove old vector before inserting new one.
        if (existing) deleteVec.run(rowid);

        upsertMeta.run(Number(rowid), n.id, n.path, n.name, snippet ?? '', nodeHash);
        insertVec.run(rowid, vecToBuffer(v));
      }
    });
    upsertBatch();
  }

  // Update the graph hash.
  db.prepare(
    "INSERT INTO embed_meta (key, value) VALUES ('graph_hash', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).run(currentHash);

  process.stderr.write(`[semantic] Done — ${nodes.length} nodes indexed at ${dbPath}\n`);
  db.close();
}

/**
 * Embed `query`, find the top-`limit` nearest nodes in the vector store, and
 * return them with cosine similarity scores.
 *
 * Throws if the DB does not exist or contains no embeddings (call `embedNodes`
 * first, or use the MCP tool which calls it automatically).
 */
export async function searchSemantic(
  query: string,
  dbPath: string,
  limit = 5,
): Promise<SemanticHit[]> {
  if (!existsSync(dbPath)) {
    throw new Error(
      `Embeddings DB not found: ${dbPath} — run \`graft build\` or call the MCP tool once first`,
    );
  }

  const db = openDb(dbPath);
  initSchema(db);

  const { c } = db.prepare('SELECT COUNT(*) AS c FROM embed_nodes').get() as { c: number };
  if (c === 0) {
    db.close();
    throw new Error(
      '[semantic] Vector index is empty — run `trail build` to populate it'
    );
  }

  const [queryVec] = await embedTexts([query]);
  const buf = vecToBuffer(queryVec!);

  // Spike 002 KNN syntax: `WHERE embedding MATCH ? AND k = N ORDER BY distance`
  // distance is L2; cosine_sim = 1 − L2²/2  (valid for unit-norm vectors).
  interface Row {
    node_id: string;
    file_path: string;
    symbol: string;
    snippet: string;
    distance: number;
  }
  const rows = db.prepare(`
    SELECT
      m.node_id,
      m.file_path,
      m.symbol,
      m.snippet,
      v.distance
    FROM vss_nodes v
    JOIN embed_nodes m ON m.rowid = v.rowid
    WHERE v.embedding MATCH ?
      AND k = ?
    ORDER BY v.distance
  `).all(buf, limit) as Row[];

  db.close();

  return rows.map(r => ({
    node_id: r.node_id,
    file_path: r.file_path,
    symbol: r.symbol,
    score: +(1 - (r.distance * r.distance) / 2).toFixed(4),
    snippet: r.snippet ?? '',
  }));
}
