#!/usr/bin/env node

/**
 * Copyright (c) 2026 Tran Huu Canh (0xTh3OKrypt) <tranhuucanh39@gmail.com>
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const [major, minor] = process.versions.node.split(".").map(Number);
if (major < 18 || (major === 18 && minor < 17)) {
  process.stderr.write(
    `[cursor-memory] Node.js >= 18.17.0 required (current: ${process.version}).\n` +
    `Fix: upgrade Node.js, then run: npm install -g cursor-memory && cursor-memory setup\n`
  );
  process.exit(1);
}

try {
  const cfgPath = path.join(os.homedir(), ".cursor-memory", "config.json");
  if (fs.existsSync(cfgPath)) {
    const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf-8"));
    if (cfg.nodeABI && cfg.nodeABI !== process.versions.modules) {
      const installedWith = cfg.nodeVersion || "unknown";
      process.stderr.write(
        `[cursor-memory] Node.js version changed (installed with ${installedWith}, now running ${process.version}).\n` +
        `Fix: run with ${installedWith}, or reinstall: npm install -g cursor-memory && cursor-memory setup\n`
      );
      process.exit(1);
    }
  }
} catch { /* config not found — first run, skip check */ }

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  insertMemory,
  updateMemory,
  deleteMemory,
  listMemories,
  getMemoryById,
  splitIntoChunks,
} from "./database.js";
import { getRepoId } from "./repo-identity.js";
import { EmbeddingService } from "./embedding-service.js";
import { searchHybrid, float32ArrayToBuffer } from "./search.js";

const embeddingService = new EmbeddingService();

const server = new McpServer({
  name: "cursor-memory",
  version: "0.1.0",
});

function getCurrentRepoId(): string | null {
  const cwd = process.env.CURSOR_WORKSPACE_PATH || process.cwd();
  return getRepoId(cwd);
}

function formatMemory(m: {
  id: number;
  content: string;
  scope: string;
  repo_id: string | null;
  tags: string[] | null;
  created_at: string;
  updated_at: string;
  rank?: number;
}): string {
  let header = `[#${m.id}] (${m.scope}${m.repo_id ? ` | ${m.repo_id}` : ""})`;
  if (m.rank !== undefined) {
    header += ` relevance: ${(m.rank * 100).toFixed(0)}%`;
  }
  const parts = [header, `${m.content}`];
  if (m.tags && m.tags.length > 0) parts.push(`Tags: ${m.tags.join(", ")}`);
  parts.push(`Saved: ${m.created_at}`);
  if (m.updated_at !== m.created_at) parts.push(`Updated: ${m.updated_at}`);
  return parts.join("\n");
}

// --- save_memory ---

server.tool(
  "save_memory",
  `Save knowledge to persistent memory.

WHEN TO SAVE:
- User says /memo followed by content → save that content directly.
- User says /memo without content → summarize the entire conversation, then save.

SUMMARY FORMAT (when /memo has no content):
Create a structured memo. Format:

## [Topic — one line]

### Decisions
- [What was chosen] — [Why]
- Always include specific names, numbers, values. NEVER be vague.
  Good: "Chose EFS over EBS — need shared access across 3 EC2 instances"
  Bad: "Chose a storage solution"

### Key Details
- Important specifics: names, versions, quantities, dates, URLs, configs
- Anything someone would need to continue or reference this work

### Context
- What problem or question was being addressed
- Constraints or trade-offs considered

### Next Steps (if any)
- Planned but not yet done

Rules:
- SKIP sections that don't apply
- Preserve ALL specifics — names, numbers, dates, amounts
- Only conclusions, NOT the discussion process
- Be as detailed as needed. For complex topics (migration plans, architecture decisions), include full breakdown
- Write as if briefing someone who will pick up this work tomorrow

TAGS — always auto-generate 2-10 tags, even if user doesn't provide any:
- topic: subject area (database, deployment, pricing, hiring, timeline, ui-design, security, networking...)
- specific: specific names/tools/concepts mentioned (postgresql, aws-efs, figma, jira, kubernetes...)
- type: kind of knowledge (decision, comparison, plan, how-to, analysis, requirement, issue-fix, reference...)
User-provided tags are merged with auto-generated ones. Never duplicate.

BEFORE SAVING: call search_memory to check for similar existing memories.
If similar exists → ask user: UPDATE existing or CREATE new?
If scope unclear → ask user: "Save globally or for this repo only?"`,
  {
    content: z.string().describe("The insight to save. Should be concise and actionable."),
    scope: z.enum(["global", "repo"]).describe("'global' for cross-project knowledge, 'repo' for project-specific"),
    tags: z.array(z.string()).optional().describe("Optional tags for categorization"),
  },
  async ({ content, scope, tags }) => {
    const repoId = scope === "repo" ? getCurrentRepoId() : null;
    if (scope === "repo" && !repoId) {
      return {
        content: [
          {
            type: "text" as const,
            text: "Cannot save repo-scoped memory: not in a git repository. Use scope 'global' instead.",
          },
        ],
      };
    }

    let chunkEmbeddings: Buffer[] = [];
    if (embeddingService.isReady()) {
      try {
        const chunks = splitIntoChunks(content);
        for (const chunk of chunks) {
          const vec = await embeddingService.embedForStorage(chunk);
          chunkEmbeddings.push(float32ArrayToBuffer(vec));
        }
      } catch { /* proceed without embedding */ }
    }

    const id = insertMemory(content, scope, repoId, tags ?? null, chunkEmbeddings);
    return {
      content: [
        {
          type: "text" as const,
          text: `Memory saved (id: ${id}, scope: ${scope}).`,
        },
      ],
    };
  }
);

// --- search_memory ---

server.tool(
  "search_memory",
  `Search persistent memory for past decisions, context, and knowledge.

PROACTIVE USE — call this tool automatically when the user's message implies
knowledge from a previous session, or when user says /recall.
Do NOT wait for an explicit command.`,
  {
    query: z.string().describe("Search query — keywords or natural language description of what to find"),
    scope: z
      .enum(["global", "repo", "all"])
      .optional()
      .describe("Filter by scope. Default 'all' returns both global and current repo memories"),
    limit: z.number().optional().describe("Max results to return. Default 5"),
  },
  async ({ query, scope, limit }) => {
    const repoId = getCurrentRepoId();
    const results = await searchHybrid(query, scope ?? "all", repoId, limit ?? 5, embeddingService);

    if (results.length === 0) {
      return {
        content: [
          { type: "text" as const, text: "No memories found matching that query." },
        ],
      };
    }

    const formatted = results.map(formatMemory).join("\n---\n");
    return {
      content: [
        {
          type: "text" as const,
          text: `Found ${results.length} memor${results.length === 1 ? "y" : "ies"}:\n\n${formatted}`,
        },
      ],
    };
  }
);

// --- update_memory ---

server.tool(
  "update_memory",
  `Update an existing memory entry. Use when a decision has changed, information needs correction,
or additional context should be added to an existing memory.

Typical flow: search_memory finds a related entry → user confirms update → call update_memory with the entry's id.`,
  {
    id: z.number().describe("ID of the memory to update"),
    content: z.string().describe("New content to replace the existing content"),
    tags: z.array(z.string()).optional().describe("New tags (replaces existing tags if provided)"),
  },
  async ({ id, content, tags }) => {
    const existing = getMemoryById(id);
    if (!existing) {
      return {
        content: [
          { type: "text" as const, text: `Memory #${id} not found.` },
        ],
      };
    }

    const repoId = getCurrentRepoId();
    if (existing.scope === "repo" && existing.repo_id !== repoId) {
      return {
        content: [
          { type: "text" as const, text: `Memory #${id} belongs to a different repo. Cannot update from here.` },
        ],
      };
    }

    let chunkEmbeddings: Buffer[] | undefined = undefined;
    if (embeddingService.isReady()) {
      try {
        chunkEmbeddings = [];
        const chunks = splitIntoChunks(content);
        for (const chunk of chunks) {
          const vec = await embeddingService.embedForStorage(chunk);
          chunkEmbeddings.push(float32ArrayToBuffer(vec));
        }
      } catch { /* proceed without re-embedding */ }
    }

    const updated = updateMemory(id, content, tags, chunkEmbeddings);
    if (!updated) {
      return {
        content: [
          { type: "text" as const, text: `Failed to update memory #${id}.` },
        ],
      };
    }

    return {
      content: [
        { type: "text" as const, text: `Memory #${id} updated.` },
      ],
    };
  }
);

// --- delete_memory ---

server.tool(
  "delete_memory",
  `Delete a memory entry. Use when user says /forget.
Show the memory content to the user and ask for confirmation before deleting.`,
  {
    id: z.number().describe("ID of the memory to delete"),
  },
  async ({ id }) => {
    const existing = getMemoryById(id);
    if (!existing) {
      return {
        content: [
          { type: "text" as const, text: `Memory #${id} not found.` },
        ],
      };
    }

    const repoId = getCurrentRepoId();
    if (existing.scope === "repo" && existing.repo_id !== repoId) {
      return {
        content: [
          { type: "text" as const, text: `Memory #${id} belongs to a different repo. Cannot delete from here.` },
        ],
      };
    }

    const deleted = deleteMemory(id);
    if (!deleted) {
      return {
        content: [
          { type: "text" as const, text: `Failed to delete memory #${id}.` },
        ],
      };
    }

    return {
      content: [
        { type: "text" as const, text: `Memory #${id} deleted.` },
      ],
    };
  }
);

// --- list_memories ---

server.tool(
  "list_memories",
  `List stored memories, optionally filtered by scope. Shows recent memories ordered by last updated.

Use when user wants to browse their saved memories or check what has been stored.`,
  {
    scope: z
      .enum(["global", "repo"])
      .optional()
      .describe("Filter by scope. If omitted, lists all memories"),
    limit: z.number().optional().describe("Max results. Default 20"),
  },
  async ({ scope, limit }) => {
    const repoId = getCurrentRepoId();
    const memories = listMemories(scope, repoId, limit ?? 20);

    if (memories.length === 0) {
      return {
        content: [
          { type: "text" as const, text: "No memories stored yet." },
        ],
      };
    }

    const formatted = memories.map(formatMemory).join("\n---\n");
    return {
      content: [
        {
          type: "text" as const,
          text: `${memories.length} memor${memories.length === 1 ? "y" : "ies"}:\n\n${formatted}`,
        },
      ],
    };
  }
);

// --- Start server ---

async function main() {
  embeddingService.init().catch(() => {
    // Model load failed — server continues with FTS5-only search
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("cursor-memory server failed to start:", err);
  process.exit(1);
});
