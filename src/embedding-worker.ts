/**
 * Copyright (c) 2026 Tran Huu Canh (0xTh3OKrypt) <tranhuucanh39@gmail.com>
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { parentPort } from "node:worker_threads";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { loadTransformers } from "./load-transformers.js";

const DATA_DIR = path.join(os.homedir(), ".cursor-memory");
const MODELS_DIR = path.join(DATA_DIR, "models");
const CONFIG_PATH = path.join(DATA_DIR, "config.json");

const MODEL_MAP: Record<string, string> = {
  small:  "Xenova/multilingual-e5-small",
  medium: "Xenova/multilingual-e5-base",
  large:  "Xenova/multilingual-e5-large",
};

function getModelId(): string {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
      if (config.model && MODEL_MAP[config.model]) {
        return MODEL_MAP[config.model];
      }
    }
  } catch { /* ignore */ }
  return MODEL_MAP.medium;
}

type EmbedRequest = { type: "embed"; id: number; text: string; prefix: "query" | "passage" };
type ShutdownRequest = { type: "shutdown" };
type WorkerMessage = EmbedRequest | ShutdownRequest;

let extractor: any = null;

async function init() {
  try {
    const { pipeline: createPipeline, env } = await loadTransformers();
    env.cacheDir = MODELS_DIR;

    const modelId = getModelId();
    extractor = await createPipeline("feature-extraction", modelId, {
      dtype: "q8",
    });

    parentPort?.postMessage({ type: "ready" });
  } catch (err) {
    parentPort?.postMessage({
      type: "error",
      error: `Failed to load embedding model: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
}

parentPort?.on("message", async (msg: WorkerMessage) => {
  if (msg.type === "shutdown") {
    process.exit(0);
  }

  if (msg.type === "embed") {
    if (!extractor) {
      parentPort?.postMessage({
        type: "error",
        id: msg.id,
        error: "Model not loaded yet",
      });
      return;
    }

    try {
      const prefixedText = `${msg.prefix}: ${msg.text}`;
      const output = await extractor(prefixedText, {
        pooling: "mean",
        normalize: true,
      });
      const embedding = Array.from(output.data as Float32Array);

      parentPort?.postMessage({
        type: "result",
        id: msg.id,
        embedding,
      });
    } catch (err) {
      parentPort?.postMessage({
        type: "error",
        id: msg.id,
        error: `Embedding failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }
});

init();
