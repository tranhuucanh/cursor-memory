#!/usr/bin/env node

/**
 * Copyright (c) 2026 Tran Huu Canh (0xTh3OKrypt) <tranhuucanh39@gmail.com>
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { Command } from "commander";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execSync } from "node:child_process";
import readline from "node:readline";

const DATA_DIR = path.join(os.homedir(), ".cursor-memory");
const DB_PATH = path.join(DATA_DIR, "memory.db");
const MODELS_DIR = path.join(DATA_DIR, "models");
const CONFIG_PATH = path.join(DATA_DIR, "config.json");

interface ModelDef {
  id: string;
  huggingface: string;
  size: string;
  description: string;
}

const MODELS: Record<string, ModelDef> = {
  small:  { id: "small",  huggingface: "Xenova/multilingual-e5-small", size: "~70MB",  description: "Lightweight, fast. Good for low-spec machines" },
  medium: { id: "medium", huggingface: "Xenova/multilingual-e5-base",  size: "~290MB", description: "Balanced accuracy and speed (recommended)" },
  large:  { id: "large",  huggingface: "Xenova/multilingual-e5-large", size: "~550MB", description: "Best accuracy, slightly more RAM usage" },
};
const DEFAULT_MODEL = "medium";

interface AppConfig {
  model: string;
  nodeABI?: string;
  nodeVersion?: string;
}

function readConfig(): AppConfig {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
    }
  } catch { /* ignore */ }
  return { model: DEFAULT_MODEL };
}

function writeConfig(config: AppConfig): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

const USER_RULE = `## cursor-memory MCP

### Auto-recall
BEFORE answering, ask yourself: "Does the user expect me to know something from a previous chat?"
If YES → call search_memory from cursor-memory MCP immediately. Do NOT answer first.
If UNSURE → answer normally, do NOT search.

Signs of past context (any language):
- References to previous decisions ("what did we choose", "as we discussed")
- Continuation requests ("continue the plan", "pick up where we left off")
- "We/our" referring to past work, not general questions
- Temporal cues: "last time", "before", "already", "remember", "yesterday"

### Auto-save awareness
After a substantive conversation, assess whether it produced knowledge worth preserving:

SUGGEST SAVING when:
- A decision was reached (chose X over Y, with reasoning)
- A plan, strategy, or approach was agreed upon
- A problem was analyzed and a solution was identified
- A comparison or evaluation was completed with a conclusion
- Important context, constraints, or requirements were established
- Knowledge was shared that would be useful to recall in future sessions

Do NOT suggest when:
- Quick Q&A with a generic/textbook answer
- Still exploring — no conclusion or decision yet
- User already said /memo in this conversation

How to suggest: at the END of your response, briefly ask:
"This seems worth remembering. Want me to /memo this?"
Do NOT auto-save without user confirmation.

### Commands
/memo → save to memory. With content: save directly. Without content: summarize conversation then save.
/recall → search via search_memory
/forget → delete via delete_memory`;

// --- MCP Config ---

interface McpConfig {
  mcpServers: Record<string, unknown>;
}

function getMcpConfigPaths(): string[] {
  const platform = os.platform();
  const home = os.homedir();

  const paths = [path.join(home, ".cursor", "mcp.json")];

  if (platform === "darwin") {
    paths.push(
      path.join(home, "Library", "Application Support", "Cursor", "User", "globalStorage", "cursor.mcp", "mcp.json")
    );
  } else if (platform === "win32") {
    const appData = process.env.APPDATA || path.join(home, "AppData", "Roaming");
    paths.push(
      path.join(appData, "Cursor", "User", "globalStorage", "cursor.mcp", "mcp.json")
    );
  } else {
    paths.push(
      path.join(home, ".config", "Cursor", "User", "globalStorage", "cursor.mcp", "mcp.json")
    );
  }

  return paths;
}

function findMcpConfig(): string | null {
  for (const p of getMcpConfigPaths()) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function resolveNodeCommand(): string {
  return process.execPath;
}

function getServerEntryPath(): string {
  try {
    const globalPrefix = execSync("npm prefix -g", { encoding: "utf-8" }).trim();
    const globalPath = path.join(globalPrefix, "lib", "node_modules", "cursor-memory", "dist", "index.js");
    if (fs.existsSync(globalPath)) return globalPath;
  } catch { /* fall through */ }

  return path.join(path.dirname(new URL(import.meta.url).pathname), "index.js");
}

function configureMcp(): { configPath: string; alreadyConfigured: boolean } {
  let configPath = findMcpConfig();

  if (!configPath) {
    configPath = path.join(os.homedir(), ".cursor", "mcp.json");
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify({ mcpServers: {} }, null, 2));
  }

  const raw = fs.readFileSync(configPath, "utf-8");
  const config: McpConfig = JSON.parse(raw);

  if (!config.mcpServers) config.mcpServers = {};

  if (config.mcpServers["cursor-memory"]) {
    return { configPath, alreadyConfigured: true };
  }

  const serverPath = getServerEntryPath();

  const nodePath = resolveNodeCommand();

  config.mcpServers["cursor-memory"] = {
    command: nodePath,
    args: [serverPath],
  };

  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  return { configPath, alreadyConfigured: false };
}

// --- User Rule ---

const RULE_FILE_CONTENT = `---
description: Proactive memory search for cursor-memory MCP
globs:
alwaysApply: true
---

${USER_RULE}
`;

function installUserRule(): { installed: boolean; message: string } {
  const rulePath = path.join(os.homedir(), ".cursor", "rules", "cursor-memory.mdc");

  try {
    if (fs.existsSync(rulePath)) {
      const existing = fs.readFileSync(rulePath, "utf-8");
      if (existing.includes("cursor-memory MCP")) {
        return { installed: true, message: "User Rule already installed." };
      }
    }

    fs.mkdirSync(path.dirname(rulePath), { recursive: true });
    fs.writeFileSync(rulePath, RULE_FILE_CONTENT);
    return { installed: true, message: `User Rule installed at ${rulePath}` };
  } catch (err) {
    return {
      installed: false,
      message: `Failed to install rule: ${err instanceof Error ? err.message : String(err)}. Manually create ${rulePath}`,
    };
  }
}

// --- Model Check ---

function isModelDownloaded(modelKey?: string): boolean {
  const key = modelKey || readConfig().model || DEFAULT_MODEL;
  const model = MODELS[key];
  if (!model) return false;
  const onnxPath = path.join(MODELS_DIR, model.huggingface, "onnx", "model_quantized.onnx");
  return fs.existsSync(onnxPath);
}

// --- Re-embed ---

async function reEmbedAll(modelKey: string, totalCount: number): Promise<void> {
  const model = MODELS[modelKey];

  const barWidth = 30;
  function progressBar(current: number, total: number): string {
    const pct = Math.round((current / total) * 100);
    const filled = Math.round((current / total) * barWidth);
    const bar = "█".repeat(filled) + "░".repeat(barWidth - filled);
    return `${bar} ${pct}% (${current}/${total})`;
  }

  process.stdout.write(`  ⏳ Re-embedding ${totalCount} memories...\n`);
  process.stdout.write(`     ${progressBar(0, totalCount)}`);

  const { pipeline, env } = await import("@huggingface/transformers");
  (env as any).cacheDir = MODELS_DIR;
  const extractor = await pipeline("feature-extraction", model.huggingface, {
    dtype: "q8" as any,
  });

  const { getAllMemoryTexts, updateChunksForMemory, reinitializeVecIndex, splitIntoChunks } = await import("./database.js");
  reinitializeVecIndex();
  const rows = getAllMemoryTexts();

  let done = 0;
  for (const row of rows) {
    const chunks = splitIntoChunks(row.content);
    const chunkTexts = chunks.map((c) => `passage: ${c}`);

    const outputs = await extractor(chunkTexts, { pooling: "mean", normalize: true });

    const chunkEmbeddings: Buffer[] = [];
    for (let j = 0; j < chunks.length; j++) {
      const dim = outputs.dims[1];
      const start = j * dim;
      const vec = new Float32Array(outputs.data.slice(start, start + dim) as Float32Array);
      chunkEmbeddings.push(Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength));
    }

    updateChunksForMemory(row.id, chunkEmbeddings);

    done++;
    process.stdout.write(`\r     ${progressBar(done, totalCount)}`);
  }

  process.stdout.write(`\r     ${progressBar(totalCount, totalCount)}\n`);
  console.log(`  ✅ ${totalCount} memories re-embedded`);
}

// --- Status Helpers ---

async function getMemoryCount(): Promise<number> {
  if (!fs.existsSync(DB_PATH)) return 0;
  try {
    const { default: Database } = await import("better-sqlite3");
    const db = new Database(DB_PATH, { readonly: true });
    const row = db.prepare("SELECT COUNT(*) as count FROM memories").get() as { count: number };
    db.close();
    return row.count;
  } catch {
    return -1;
  }
}

function checkNodeABI(): boolean {
  const config = readConfig();
  if (config.nodeABI && config.nodeABI !== process.versions.modules) {
    const installedWith = config.nodeVersion || "unknown";
    console.log(`  ⚠️  Node.js version changed (installed with ${installedWith}, now running ${process.version}).`);
    console.log(`     Fix: run with ${installedWith}, or reinstall: npm install -g cursor-memory && cursor-memory setup`);
    console.log();
    return false;
  }
  return true;
}

// --- Commands ---

const program = new Command();

program
  .name("cursor-memory")
  .description("Local-first persistent memory for Cursor AI")
  .version("1.0.1", "-v, --version");

program
  .command("setup")
  .description("Configure cursor-memory MCP server and download embedding model")
  .option("--model <size>", "Embedding model size: small, medium, or large")
  .action(async (opts: { model?: string }) => {
    console.log();
    console.log("  cursor-memory setup");
    console.log("  ───────────────────");
    console.log();

    // 1. MCP config
    const { alreadyConfigured } = configureMcp();
    console.log(`  ✅ ${alreadyConfigured ? "MCP server already configured" : "MCP server configured"}`);

    // 2. User Rule
    const { installed, message } = installUserRule();
    console.log(installed ? "  ✅ User rule installed" : `  ⚠️  ${message}`);

    // 3. Model selection
    let modelKey: string;

    if (opts.model) {
      const key = opts.model.toLowerCase();
      if (!MODELS[key]) {
        console.log(`  ❌ Unknown model "${opts.model}". Choose: small, medium, or large.`);
        console.log();
        return;
      }
      modelKey = key;
    } else {
      const currentConfig = readConfig();
      const currentModel = currentConfig.model || DEFAULT_MODEL;

      console.log();
      console.log("  Select embedding model:");
      console.log();
      const keys = Object.keys(MODELS);
      for (let i = 0; i < keys.length; i++) {
        const k = keys[i];
        const m = MODELS[k];
        const current = k === currentModel ? " (current)" : "";
        const rec = k === DEFAULT_MODEL ? " ★" : "";
        console.log(`    ${i + 1}) ${k.padEnd(8)} ${m.size.padEnd(8)} ${m.description}${rec}${current}`);
      }
      console.log();

      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      const answer = await new Promise<string>((resolve) => {
        rl.question(`  Choose [1-3] (default: ${keys.indexOf(currentModel) + 1}): `, resolve);
      });
      rl.close();

      const choice = answer.trim();
      if (choice === "" || choice === String(keys.indexOf(currentModel) + 1)) {
        modelKey = currentModel;
      } else if (choice === "1" || choice === "2" || choice === "3") {
        modelKey = keys[parseInt(choice) - 1];
      } else if (MODELS[choice.toLowerCase()]) {
        modelKey = choice.toLowerCase();
      } else {
        console.log(`  ❌ Invalid choice "${choice}".`);
        console.log();
        return;
      }
    }

    const model = MODELS[modelKey];
    const currentConfig = readConfig();
    const previousModel = currentConfig.model;
    const modelChanged = previousModel && previousModel !== modelKey;

    // Count existing memories — if count fails but DB file exists, assume data is present
    let memoryCount = 0;
    if (modelChanged && fs.existsSync(DB_PATH)) {
      try {
        memoryCount = await getMemoryCount();
        if (memoryCount < 0) memoryCount = 1;
      } catch { memoryCount = 1; }
    }

    // If switching model with existing data, offer re-embed or clear
    let shouldReEmbed = false;
    if (modelChanged && memoryCount > 0) {
      console.log();
      console.log(`  ⚠️  Switching model: ${previousModel} → ${modelKey}`);
      console.log(`     You have ${memoryCount} saved memories.`);
      console.log();
      console.log("    1) Re-embed  — keep all memories, regenerate embeddings");
      console.log("    2) Clear     — delete all memories and start fresh");
      console.log("    3) Cancel    — keep current model");
      console.log();

      const rl2 = readline.createInterface({ input: process.stdin, output: process.stdout });
      const switchChoice = await new Promise<string>((resolve) => {
        rl2.question("  Choose [1-3] (default: 1): ", resolve);
      });
      rl2.close();

      const sc = switchChoice.trim();
      if (sc === "3") {
        console.log("  Cancelled.");
        console.log();
        return;
      } else if (sc === "2") {
        fs.unlinkSync(DB_PATH);
        const shm = DB_PATH + "-shm";
        const wal = DB_PATH + "-wal";
        if (fs.existsSync(shm)) fs.unlinkSync(shm);
        if (fs.existsSync(wal)) fs.unlinkSync(wal);
        console.log("  ✅ Memories cleared");
      } else {
        shouldReEmbed = true;
      }
    }

    writeConfig({ model: modelKey, nodeABI: process.versions.modules, nodeVersion: process.version });

    // 4. Model download
    if (!isModelDownloaded(modelKey)) {
      process.stdout.write(`  ⏳ Downloading model "${modelKey}" (${model.size})...`);
      try {
        const { pipeline, env } = await import("@huggingface/transformers");
        (env as any).cacheDir = MODELS_DIR;
        await pipeline("feature-extraction", model.huggingface, {
          dtype: "q8" as any,
        });
        process.stdout.write(`\r  ✅ Model "${modelKey}" downloaded                  \n`);
      } catch (err) {
        process.stdout.write("\r  ❌ Model download failed                           \n");
        console.error(`     ${err instanceof Error ? err.message : String(err)}`);
        console.error("     Run 'cursor-memory setup' again when you have internet.");
        console.log();
        return;
      }
    } else {
      console.log(`  ✅ Embedding model ready (${modelKey})`);
    }

    // 5. Re-embed if needed
    if (shouldReEmbed) {
      console.log();
      try {
        await reEmbedAll(modelKey, memoryCount);
      } catch (err) {
        console.error(`  ❌ Re-embedding failed: ${err instanceof Error ? err.message : String(err)}`);
        console.error("     Some memories may have outdated embeddings. Run setup again to retry.");
      }
    }

    console.log();
    console.log("  🟢 Ready — restart Cursor to activate.");
    console.log();
  });

program
  .command("status")
  .description("Check cursor-memory installation status")
  .action(async () => {
    console.log();
    console.log("  cursor-memory status");
    console.log("  ────────────────────");
    console.log();

    checkNodeABI();

    // MCP config
    const configPath = findMcpConfig();
    let mcpOk = false;
    if (configPath) {
      const raw = fs.readFileSync(configPath, "utf-8");
      const config: McpConfig = JSON.parse(raw);
      mcpOk = !!config.mcpServers?.["cursor-memory"];
    }
    console.log(mcpOk ? "  ✅ MCP server configured" : "  ❌ MCP server not configured");

    // User Rule
    const rulePath = path.join(os.homedir(), ".cursor", "rules", "cursor-memory.mdc");
    console.log(fs.existsSync(rulePath) ? "  ✅ User rule installed" : "  ❌ User rule not installed");

    // Model
    const currentModel = readConfig().model || DEFAULT_MODEL;
    console.log(isModelDownloaded() ? `  ✅ Embedding model ready (${currentModel})` : "  ❌ Embedding model not downloaded");

    // Database
    if (fs.existsSync(DB_PATH)) {
      const count = await getMemoryCount();
      console.log(count >= 0 ? `  ✅ Database: ${count} memories` : "  ✅ Database exists");
    } else {
      console.log("  ○  Database empty (created on first use)");
    }

    if (!mcpOk || !fs.existsSync(rulePath) || !isModelDownloaded()) {
      console.log("\n  Run 'cursor-memory setup' to fix missing items.");
    }
    console.log();
  });

program
  .command("reset")
  .description("Delete all stored memories (keeps model cache)")
  .action(async () => {
    if (!fs.existsSync(DB_PATH)) {
      console.log("No database to reset.");
      return;
    }

    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = await new Promise<string>((resolve) => {
      rl.question("Delete all memories? This cannot be undone. (y/N) ", resolve);
    });
    rl.close();

    if (answer.toLowerCase() !== "y") {
      console.log("Cancelled.");
      return;
    }

    try {
      fs.unlinkSync(DB_PATH);
      const shm = DB_PATH + "-shm";
      const wal = DB_PATH + "-wal";
      if (fs.existsSync(shm)) fs.unlinkSync(shm);
      if (fs.existsSync(wal)) fs.unlinkSync(wal);
      console.log("✓ All memories deleted.");
    } catch (err) {
      console.error(`Failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  });

program.parse();
