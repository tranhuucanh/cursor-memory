/**
 * Copyright (c) 2026 Tran Huu Canh (0xTh3OKrypt) <tranhuucanh39@gmail.com>
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { execSync } from "node:child_process";

export function getRepoId(cwd: string): string | null {
  const remote = getGitRemoteUrl(cwd);
  if (remote) return normalizeRemoteUrl(remote);

  const rootCommit = getGitRootCommit(cwd);
  if (rootCommit) return `commit:${rootCommit}`;

  return null;
}

function getGitRemoteUrl(cwd: string): string | null {
  try {
    return execSync("git remote get-url origin", {
      cwd,
      encoding: "utf-8",
      timeout: 5000,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  } catch {
    return null;
  }
}

function getGitRootCommit(cwd: string): string | null {
  try {
    return execSync("git rev-list --max-parents=0 HEAD", {
      cwd,
      encoding: "utf-8",
      timeout: 5000,
      stdio: ["pipe", "pipe", "pipe"],
    })
      .trim()
      .split("\n")[0];
  } catch {
    return null;
  }
}

function normalizeRemoteUrl(url: string): string {
  return url
    .replace(/\.git$/, "")
    .replace(/^git@([^:]+):/, "https://$1/")
    .replace(/\/+$/, "");
}
