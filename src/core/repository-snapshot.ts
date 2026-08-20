import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

import type { RepositorySnapshot } from "../domain/types.js";

function git(root: string, args: string[]): string {
  return execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    timeout: 5_000,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

export function captureRepositorySnapshot(root: string): RepositorySnapshot {
  const normalized = resolve(root);
  const base: RepositorySnapshot = {
    root: normalized,
    isGitRepository: false,
    branch: null,
    head: null,
    dirty: false,
    changedFiles: [],
    capturedAt: new Date().toISOString(),
  };
  try {
    base.isGitRepository = git(normalized, ["rev-parse", "--is-inside-work-tree"]) === "true";
    if (!base.isGitRepository) return base;
    base.branch = git(normalized, ["branch", "--show-current"]) || null;
    base.head = git(normalized, ["rev-parse", "HEAD"]) || null;
    const status = git(normalized, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
    base.changedFiles = status
      ? status.split("\0").filter(Boolean).map((entry) => entry.slice(3)).slice(0, 200)
      : [];
    base.dirty = base.changedFiles.length > 0;
    return base;
  } catch (error) {
    const message = error instanceof Error ? error.message.split("\n")[0] : String(error);
    return {
      ...base,
      error: message ?? "Unknown Git error",
    };
  }
}
