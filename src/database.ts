/**
 * Copyright (c) 2026 Tran Huu Canh (0xTh3OKrypt) <tranhuucanh39@gmail.com>
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

export interface Memory {
  id: number;
  content: string;
  embedding: Buffer | null;
  scope: "global" | "repo";
  repo_id: string | null;
  tags: string[] | null;
  created_at: string;
  updated_at: string;
}

export interface MemorySearchResult extends Memory {
  rank: number;
}

const DATA_DIR = path.join(os.homedir(), ".cursor-memory");
const DB_PATH = path.join(DATA_DIR, "memory.db");

const MAX_CHUNK_WORDS = 350;
const OVERLAP_WORDS = 50;

let db: Database.Database | null = null;
let vecEnabled = false;

export function isVecEnabled(): boolean {
  return vecEnabled;
}

export function splitIntoChunks(text: string): string[] {
  const words = text.split(/\s+/).filter((w) => w.length > 0);
  if (words.length <= MAX_CHUNK_WORDS) return [text];

  const chunks: string[] = [];
  let start = 0;
  while (start < words.length) {
    const end = Math.min(start + MAX_CHUNK_WORDS, words.length);
    chunks.push(words.slice(start, end).join(" "));
    if (end >= words.length) break;
    start = end - OVERLAP_WORDS;
  }
  return chunks;
}

export function getDb(): Database.Database {
  if (db) return db;

  fs.mkdirSync(DATA_DIR, { recursive: true });

  db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  initSchema(db);
  return db;
}

function getConfiguredDimension(): number {
  const configPath = path.join(DATA_DIR, "config.json");
  try {
    const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    const dims: Record<string, number> = { small: 384, medium: 768, large: 1024 };
    return dims[config.model] || 768;
  } catch {
    return 768;
  }
}

function initSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS memories (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      content     TEXT NOT NULL,
      embedding   BLOB,
      scope       TEXT NOT NULL CHECK(scope IN ('global', 'repo')),
      repo_id     TEXT,
      tags        TEXT,
      created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at  DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  db.exec("CREATE INDEX IF NOT EXISTS idx_memories_scope_repo ON memories(scope, repo_id)");

  const ftsExists = db
    .prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='memories_fts'`
    )
    .get();

  if (!ftsExists) {
    db.exec(`
      CREATE VIRTUAL TABLE memories_fts USING fts5(
        content,
        content='memories',
        content_rowid='id'
      );

      INSERT INTO memories_fts(rowid, content)
        SELECT id, content FROM memories;

      CREATE TRIGGER memories_ai AFTER INSERT ON memories BEGIN
        INSERT INTO memories_fts(rowid, content) VALUES (new.id, new.content);
      END;

      CREATE TRIGGER memories_ad AFTER DELETE ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, content) VALUES('delete', old.id, old.content);
      END;

      CREATE TRIGGER memories_au AFTER UPDATE OF content ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, content) VALUES('delete', old.id, old.content);
        INSERT INTO memories_fts(rowid, content) VALUES (new.id, new.content);
      END;
    `);
  }

  db.exec("CREATE TABLE IF NOT EXISTS cursor_memory_meta (key TEXT PRIMARY KEY, value TEXT)");

  const SCHEMA_VERSION = 2;
  const verRow = db.prepare("SELECT value FROM cursor_memory_meta WHERE key = 'schema_version'").get() as
    | { value: string }
    | undefined;
  const currentVersion = verRow ? Number(verRow.value) : 0;

  if (currentVersion < 2) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS memory_chunks (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        memory_id  INTEGER NOT NULL,
        chunk_index INTEGER NOT NULL,
        FOREIGN KEY (memory_id) REFERENCES memories(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_chunks_memory ON memory_chunks(memory_id);
    `);
  }

  db.prepare("INSERT OR REPLACE INTO cursor_memory_meta(key, value) VALUES ('schema_version', ?)").run(
    String(SCHEMA_VERSION)
  );

  try {
    sqliteVec.load(db);
    vecEnabled = true;
    initVecTable(db);
  } catch {
    vecEnabled = false;
  }
}

function initVecTable(db: Database.Database): void {
  const dim = getConfiguredDimension();

  const meta = db.prepare("SELECT value FROM cursor_memory_meta WHERE key = 'vec_dim'").get() as
    | { value: string }
    | undefined;
  const existingDim = meta ? Number(meta.value) : null;

  const tableExists = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='vec_memories'")
    .get();

  if (tableExists && existingDim === dim) return;

  db.exec("DROP TABLE IF EXISTS vec_memories");
  db.exec(`CREATE VIRTUAL TABLE vec_memories USING vec0(embedding float[${dim}] distance_metric=cosine)`);

  db.exec("DELETE FROM memory_chunks");

  const rows = db.prepare("SELECT id, embedding FROM memories WHERE embedding IS NOT NULL").all() as {
    id: number;
    embedding: Buffer;
  }[];

  if (rows.length > 0) {
    const insertChunk = db.prepare("INSERT INTO memory_chunks(memory_id, chunk_index) VALUES (?, ?)");
    const insertVec = db.prepare("INSERT INTO vec_memories(rowid, embedding) VALUES (?, ?)");
    const tx = db.transaction(() => {
      for (const row of rows) {
        try {
          const chunkResult = insertChunk.run(row.id, 0);
          const chunkId = Number(chunkResult.lastInsertRowid);
          insertVec.run(BigInt(chunkId), row.embedding);
        } catch {
          /* skip incompatible embeddings */
        }
      }
    });
    tx();
  }

  db.prepare("INSERT OR REPLACE INTO cursor_memory_meta(key, value) VALUES ('vec_dim', ?)").run(
    String(dim)
  );
}

export function reinitializeVecIndex(): void {
  if (!vecEnabled) return;
  const database = getDb();
  database.exec("DROP TABLE IF EXISTS vec_memories");
  database.exec("DELETE FROM memory_chunks");
  database.prepare("DELETE FROM cursor_memory_meta WHERE key = 'vec_dim'").run();
  initVecTable(database);
}

export function insertMemory(
  content: string,
  scope: "global" | "repo",
  repoId: string | null,
  tags: string[] | null,
  chunkEmbeddings: Buffer[] = []
): number {
  const db = getDb();
  const firstEmbed = chunkEmbeddings.length > 0 ? chunkEmbeddings[0] : null;

  const result = db
    .prepare(
      `INSERT INTO memories (content, embedding, scope, repo_id, tags)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(content, firstEmbed, scope, repoId, tags ? JSON.stringify(tags) : null);

  const memoryId = Number(result.lastInsertRowid);

  if (vecEnabled && chunkEmbeddings.length > 0) {
    const insertChunk = db.prepare("INSERT INTO memory_chunks(memory_id, chunk_index) VALUES (?, ?)");
    const insertVec = db.prepare("INSERT INTO vec_memories(rowid, embedding) VALUES (?, ?)");

    for (let i = 0; i < chunkEmbeddings.length; i++) {
      try {
        const chunkResult = insertChunk.run(memoryId, i);
        const chunkId = Number(chunkResult.lastInsertRowid);
        insertVec.run(BigInt(chunkId), chunkEmbeddings[i]);
      } catch {
        /* chunk insert failed — FTS still works */
      }
    }
  }

  return memoryId;
}

export function updateMemory(
  id: number,
  content: string,
  tags?: string[] | null,
  chunkEmbeddings?: Buffer[]
): boolean {
  const db = getDb();
  const fields: string[] = ["content = ?", "updated_at = CURRENT_TIMESTAMP"];
  const params: unknown[] = [content];

  if (tags !== undefined) {
    fields.push("tags = ?");
    params.push(tags ? JSON.stringify(tags) : null);
  }

  if (chunkEmbeddings !== undefined && chunkEmbeddings.length > 0) {
    fields.push("embedding = ?");
    params.push(chunkEmbeddings[0]);
  }

  params.push(id);
  const result = db
    .prepare(`UPDATE memories SET ${fields.join(", ")} WHERE id = ?`)
    .run(...params);

  if (vecEnabled && chunkEmbeddings !== undefined) {
    const oldChunks = db.prepare("SELECT id FROM memory_chunks WHERE memory_id = ?").all(id) as {
      id: number;
    }[];
    for (const chunk of oldChunks) {
      try {
        db.prepare("DELETE FROM vec_memories WHERE rowid = ?").run(BigInt(chunk.id));
      } catch {
        /* ignore */
      }
    }
    db.prepare("DELETE FROM memory_chunks WHERE memory_id = ?").run(id);

    if (chunkEmbeddings.length > 0) {
      const insertChunk = db.prepare("INSERT INTO memory_chunks(memory_id, chunk_index) VALUES (?, ?)");
      const insertVec = db.prepare("INSERT INTO vec_memories(rowid, embedding) VALUES (?, ?)");

      for (let i = 0; i < chunkEmbeddings.length; i++) {
        try {
          const chunkResult = insertChunk.run(id, i);
          const chunkId = Number(chunkResult.lastInsertRowid);
          insertVec.run(BigInt(chunkId), chunkEmbeddings[i]);
        } catch {
          /* skip */
        }
      }
    }
  }

  return result.changes > 0;
}

export function deleteMemory(id: number): boolean {
  const db = getDb();

  if (vecEnabled) {
    const chunks = db.prepare("SELECT id FROM memory_chunks WHERE memory_id = ?").all(id) as {
      id: number;
    }[];
    for (const chunk of chunks) {
      try {
        db.prepare("DELETE FROM vec_memories WHERE rowid = ?").run(BigInt(chunk.id));
      } catch {
        /* ignore */
      }
    }
  }

  // CASCADE deletes memory_chunks rows automatically
  const result = db.prepare("DELETE FROM memories WHERE id = ?").run(id);
  return result.changes > 0;
}

export function listMemories(
  scope: "global" | "repo" | undefined,
  repoId: string | null,
  limit: number = 20
): Memory[] {
  const db = getDb();

  let sql = "SELECT * FROM memories";
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (scope === "global") {
    conditions.push("scope = 'global'");
  } else if (scope === "repo") {
    conditions.push("scope = 'repo'");
    if (repoId) {
      conditions.push("repo_id = ?");
      params.push(repoId);
    }
  }

  if (conditions.length > 0) {
    sql += " WHERE " + conditions.join(" AND ");
  }

  sql += " ORDER BY updated_at DESC LIMIT ?";
  params.push(limit);

  const rows = db.prepare(sql).all(...params) as RawMemoryRow[];
  return rows.map(parseMemoryRow);
}

export function searchByKeyword(
  query: string,
  scope: "global" | "repo" | "all" | undefined,
  repoId: string | null,
  limit: number = 5
): MemorySearchResult[] {
  const db = getDb();

  let sql = `
    SELECT m.*, rank
    FROM memories_fts fts
    JOIN memories m ON m.id = fts.rowid
    WHERE memories_fts MATCH ?
  `;
  const params: unknown[] = [sanitizeFtsQuery(query)];

  if (scope === "global") {
    sql += " AND m.scope = 'global'";
  } else if (scope === "repo" && repoId) {
    sql += " AND m.scope = 'repo' AND m.repo_id = ?";
    params.push(repoId);
  } else if (scope === "all" || scope === undefined) {
    if (repoId) {
      sql += " AND (m.scope = 'global' OR (m.scope = 'repo' AND m.repo_id = ?))";
      params.push(repoId);
    } else {
      sql += " AND m.scope = 'global'";
    }
  }

  sql += " ORDER BY rank LIMIT ?";
  params.push(limit);

  const rows = db.prepare(sql).all(...params) as (RawMemoryRow & { rank: number })[];
  return rows.map((row) => ({
    ...parseMemoryRow(row),
    rank: row.rank,
  }));
}

export interface VecSearchResult {
  id: number;
  distance: number;
}

export function vectorSearch(
  queryEmbedding: Buffer,
  scope: "global" | "repo" | "all" | undefined,
  repoId: string | null,
  limit: number
): VecSearchResult[] {
  if (!vecEnabled) return [];

  const db = getDb();
  const overFetch = limit * 5;

  // Step 1: KNN search + join through memory_chunks to get memory_id
  let rawResults: { memory_id: number; distance: number }[];
  try {
    rawResults = db.prepare(`
      SELECT mc.memory_id, v.distance
      FROM vec_memories v
      JOIN memory_chunks mc ON mc.id = v.rowid
      WHERE v.embedding MATCH ?
        AND v.k = ?
    `).all(queryEmbedding, overFetch) as { memory_id: number; distance: number }[];
  } catch {
    return [];
  }

  // Step 2: Dedup by memory_id (keep best/lowest distance per memory)
  const bestPerMemory = new Map<number, number>();
  for (const r of rawResults) {
    const existing = bestPerMemory.get(r.memory_id);
    if (existing === undefined || r.distance < existing) {
      bestPerMemory.set(r.memory_id, r.distance);
    }
  }

  // Step 3: Apply scope filter
  const filtered: VecSearchResult[] = [];
  for (const [memoryId, distance] of bestPerMemory) {
    const mem = db.prepare("SELECT scope, repo_id FROM memories WHERE id = ?").get(memoryId) as {
      scope: string;
      repo_id: string | null;
    } | undefined;
    if (!mem) continue;

    if (scope === "global" && mem.scope !== "global") continue;
    if (scope === "repo" && repoId && !(mem.scope === "repo" && mem.repo_id === repoId)) continue;
    if (scope === "all" || scope === undefined) {
      if (repoId) {
        if (!(mem.scope === "global" || (mem.scope === "repo" && mem.repo_id === repoId))) continue;
      } else {
        if (mem.scope !== "global") continue;
      }
    }

    filtered.push({ id: memoryId, distance });
  }

  // Step 4: Sort by distance, limit
  filtered.sort((a, b) => a.distance - b.distance);
  return filtered.slice(0, limit);
}

export function getMemoryById(id: number): Memory | undefined {
  const db = getDb();
  const row = db.prepare("SELECT * FROM memories WHERE id = ?").get(id) as
    | RawMemoryRow
    | undefined;
  return row ? parseMemoryRow(row) : undefined;
}

interface RawMemoryRow {
  id: number;
  content: string;
  embedding: Buffer | null;
  scope: string;
  repo_id: string | null;
  tags: string | null;
  created_at: string;
  updated_at: string;
}

function parseMemoryRow(row: RawMemoryRow): Memory {
  return {
    ...row,
    scope: row.scope as "global" | "repo",
    tags: row.tags ? JSON.parse(row.tags) : null,
  };
}

export interface MemoryTextRow {
  id: number;
  content: string;
}

export function getAllMemoryTexts(): MemoryTextRow[] {
  const db = getDb();
  return db.prepare("SELECT id, content FROM memories ORDER BY id").all() as MemoryTextRow[];
}

export function updateChunksForMemory(id: number, chunkEmbeddings: Buffer[]): void {
  const db = getDb();

  const firstEmbed = chunkEmbeddings.length > 0 ? chunkEmbeddings[0] : null;
  db.prepare("UPDATE memories SET embedding = ? WHERE id = ?").run(firstEmbed, id);

  if (vecEnabled) {
    const oldChunks = db.prepare("SELECT id FROM memory_chunks WHERE memory_id = ?").all(id) as {
      id: number;
    }[];
    for (const chunk of oldChunks) {
      try {
        db.prepare("DELETE FROM vec_memories WHERE rowid = ?").run(BigInt(chunk.id));
      } catch {
        /* ignore */
      }
    }
    db.prepare("DELETE FROM memory_chunks WHERE memory_id = ?").run(id);

    if (chunkEmbeddings.length > 0) {
      const insertChunk = db.prepare("INSERT INTO memory_chunks(memory_id, chunk_index) VALUES (?, ?)");
      const insertVec = db.prepare("INSERT INTO vec_memories(rowid, embedding) VALUES (?, ?)");

      for (let i = 0; i < chunkEmbeddings.length; i++) {
        try {
          const chunkResult = insertChunk.run(id, i);
          const chunkId = Number(chunkResult.lastInsertRowid);
          insertVec.run(BigInt(chunkId), chunkEmbeddings[i]);
        } catch {
          /* skip */
        }
      }
    }
  }
}

function sanitizeFtsQuery(query: string): string {
  const tokens = query
    .replace(/[^\w\s\u00C0-\u024F\u1E00-\u1EFF\u3000-\u9FFF\uAC00-\uD7AF]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 0);
  if (tokens.length === 0) return '""';
  return tokens.join(" OR ");
}
