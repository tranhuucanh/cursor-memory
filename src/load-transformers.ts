/**
 * Copyright (c) 2026 Tran Huu Canh (0xTh3OKrypt) <tranhuucanh39@gmail.com>
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import path from "node:path";
import os from "node:os";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const isWindows = process.platform === "win32";
const modulesDir = isWindows
  ? path.join(os.homedir(), ".cursor-memory", "node_modules")
  : path.join(os.homedir(), ".cursor-memory", "lib", "node_modules");

export async function loadTransformers() {
  try {
    return await import("@huggingface/transformers");
  } catch {
    const req = createRequire(path.join(modulesDir, "_.cjs"));
    const resolved = req.resolve("@huggingface/transformers");
    return await import(pathToFileURL(resolved).href);
  }
}
