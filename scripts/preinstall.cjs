/**
 * Copyright (c) 2026 Tran Huu Canh (0xTh3OKrypt) <tranhuucanh39@gmail.com>
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

const SUPPORTED_NODE_MAJORS = [20, 22, 23, 24, 25, 26];
const nodeMajor = parseInt(process.versions.node.split(".")[0], 10);

if (!SUPPORTED_NODE_MAJORS.includes(nodeMajor)) {
  console.error("");
  console.error("  cursor-memory: unsupported Node.js version");
  console.error("  ─────────────────────────────────────────────");
  console.error("");
  console.error("  Detected:    Node " + process.versions.node);
  console.error("  Recommended: Node 20, 22, or 24 LTS");
  console.error("");
  console.error("  Native modules (better-sqlite3) ship prebuilt binaries");
  console.error("  for LTS versions only. Other versions try to compile from");
  console.error("  source and usually fail (missing Python / C++ toolchain).");
  console.error("");
  console.error("  Install Node LTS: https://nodejs.org");
  console.error("  Or use nvm:       nvm install 22 && nvm use 22");
  console.error("");
  process.exit(1);
}
