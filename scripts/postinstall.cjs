/**
 * Copyright (c) 2026 Tran Huu Canh (0xTh3OKrypt) <tranhuucanh39@gmail.com>
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

const { execSync } = require("child_process");
const path = require("path");
const os = require("os");
const fs = require("fs");

const dataDir = path.join(os.homedir(), ".cursor-memory");
const isWindows = process.platform === "win32";
const modulesDir = isWindows
  ? path.join(dataDir, "node_modules")
  : path.join(dataDir, "lib", "node_modules");

fs.mkdirSync(dataDir, { recursive: true });

try {
  require.resolve("@huggingface/transformers", { paths: [modulesDir] });
} catch {
  console.log("cursor-memory: Installing embedding engine...");
  try {
    execSync(
      "npm install --prefix " +
        JSON.stringify(dataDir) +
        " @huggingface/transformers",
      {
        stdio: "inherit",
        env: { ...process.env, SHARP_IGNORE_GLOBAL_LIBVIPS: "1" },
      }
    );
    console.log("cursor-memory: Embedding engine installed.");
  } catch {
    console.log(
      "cursor-memory: Auto-install failed. Run 'cursor-memory setup' to retry."
    );
  }
}
