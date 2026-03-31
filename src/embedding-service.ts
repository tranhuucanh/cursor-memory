/**
 * Copyright (c) 2026 Tran Huu Canh (0xTh3OKrypt) <tranhuucanh39@gmail.com>
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { Worker } from "node:worker_threads";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

interface PendingRequest {
  resolve: (embedding: Float32Array) => void;
  reject: (error: Error) => void;
}

export class EmbeddingService {
  private worker: Worker | null = null;
  private ready = false;
  private requestId = 0;
  private pending = new Map<number, PendingRequest>();
  private initPromise: Promise<void> | null = null;

  async init(): Promise<void> {
    if (this.initPromise) return this.initPromise;

    this.initPromise = new Promise<void>((resolve, reject) => {
      const workerPath = path.join(__dirname, "embedding-worker.js");
      this.worker = new Worker(workerPath);

      const timeout = setTimeout(() => {
        reject(new Error("Embedding worker timed out during model load (5 min)"));
      }, 5 * 60 * 1000);

      this.worker.on("message", (msg) => {
        if (msg.type === "ready") {
          this.ready = true;
          clearTimeout(timeout);
          resolve();
          return;
        }

        if (msg.type === "result" && msg.id !== undefined) {
          const req = this.pending.get(msg.id);
          if (req) {
            this.pending.delete(msg.id);
            req.resolve(new Float32Array(msg.embedding));
          }
          return;
        }

        if (msg.type === "error") {
          if (msg.id !== undefined) {
            const req = this.pending.get(msg.id);
            if (req) {
              this.pending.delete(msg.id);
              req.reject(new Error(msg.error));
            }
          } else {
            clearTimeout(timeout);
            this.ready = false;
            reject(new Error(msg.error));
          }
        }
      });

      this.worker.on("error", (err) => {
        this.ready = false;
        clearTimeout(timeout);
        for (const req of this.pending.values()) {
          req.reject(err);
        }
        this.pending.clear();
        reject(err);
      });

      this.worker.on("exit", (code) => {
        this.ready = false;
        this.worker = null;
        if (code !== 0) {
          const err = new Error(`Embedding worker exited with code ${code}`);
          for (const req of this.pending.values()) {
            req.reject(err);
          }
          this.pending.clear();
        }
      });
    });

    return this.initPromise;
  }

  isReady(): boolean {
    return this.ready && this.worker !== null;
  }

  async embedForStorage(text: string): Promise<Float32Array> {
    return this.embed(text, "passage");
  }

  async embedForSearch(text: string): Promise<Float32Array> {
    return this.embed(text, "query");
  }

  private async embed(text: string, prefix: "query" | "passage"): Promise<Float32Array> {
    if (!this.isReady() || !this.worker) {
      throw new Error("Embedding service not ready");
    }

    const id = ++this.requestId;
    return new Promise<Float32Array>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker!.postMessage({ type: "embed", id, text, prefix });
    });
  }

  async shutdown(): Promise<void> {
    if (this.worker) {
      this.worker.postMessage({ type: "shutdown" });
      this.worker = null;
      this.ready = false;
    }
    this.pending.clear();
  }
}
