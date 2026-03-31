/**
 * Copyright (c) 2026 Tran Huu Canh (0xTh3OKrypt) <tranhuucanh39@gmail.com>
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import {
  searchByKeyword,
  vectorSearch,
  getMemoryById,
  type MemorySearchResult,
} from "./database.js";
import type { EmbeddingService } from "./embedding-service.js";

const FTS_WEIGHT = 0.4;
const VECTOR_WEIGHT = 0.6;
const VECTOR_MIN_SIMILARITY = 0.2;

export async function searchHybrid(
  query: string,
  scope: "global" | "repo" | "all" | undefined,
  repoId: string | null,
  limit: number,
  embeddingService: EmbeddingService | null
): Promise<MemorySearchResult[]> {
  if (!embeddingService?.isReady()) {
    return searchByKeyword(query, scope, repoId, limit);
  }

  const ftsResultsRaw = searchByKeyword(query, scope, repoId, limit * 2);

  let queryEmbedding: Float32Array;
  try {
    queryEmbedding = await embeddingService.embedForSearch(query);
  } catch {
    return ftsResultsRaw.slice(0, limit);
  }

  const queryBuf = float32ArrayToBuffer(queryEmbedding);
  const vecResults = vectorSearch(queryBuf, scope, repoId, limit * 3);

  const vectorScores = new Map<number, number>();
  for (const { id, distance } of vecResults) {
    vectorScores.set(id, 1 - distance);
  }

  const scoreMap = new Map<number, { ftsNorm: number; vecNorm: number }>();

  const ftsMax =
    ftsResultsRaw.length > 0
      ? Math.max(...ftsResultsRaw.map((r) => Math.abs(r.rank)))
      : 1;

  for (const r of ftsResultsRaw) {
    const ftsNorm = ftsMax > 0 ? Math.abs(r.rank) / ftsMax : 0;
    const vecNorm = vectorScores.get(r.id) ?? 0;
    scoreMap.set(r.id, { ftsNorm, vecNorm });
  }

  const vectorOnly = [...vectorScores.entries()].filter(
    ([id, sim]) => !scoreMap.has(id) && sim >= VECTOR_MIN_SIMILARITY
  );

  for (const [id, sim] of vectorOnly) {
    scoreMap.set(id, { ftsNorm: 0, vecNorm: sim });
  }

  const ranked = [...scoreMap.entries()]
    .map(([id, scores]) => ({
      id,
      score: FTS_WEIGHT * scores.ftsNorm + VECTOR_WEIGHT * scores.vecNorm,
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  const results: MemorySearchResult[] = [];
  for (const { id, score } of ranked) {
    const existing = ftsResultsRaw.find((r) => r.id === id);
    if (existing) {
      results.push({ ...existing, rank: score });
    } else {
      const mem = getMemoryById(id);
      if (mem) {
        results.push({ ...mem, rank: score });
      }
    }
  }

  return results;
}

export function float32ArrayToBuffer(arr: Float32Array): Buffer {
  return Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength);
}
