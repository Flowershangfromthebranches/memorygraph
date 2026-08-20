import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

import type { RepositorySnapshot } from "../domain/types.js";

function git(root: string, args: string[], trimOutput = true): string {
  const output = execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    timeout: 5_000,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return trimOutput ? output.trim() : output;
}

export function parsePorcelainZ(status: string): string[] {
  const entries = status.split("\0");
  const paths: string[] = [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (!entry || entry.length < 4) continue;
    const code = entry.slice(0, 2);
    paths.push(entry.slice(3));
    if (code.includes("R") || code.includes("C")) index += 1;
  }
  return paths;
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
    const status = git(normalized, ["status", "--porcelain=v1", "-z", "--untracked-files=all"], false);
    base.changedFiles = parsePorcelainZ(status).slice(0, 200);
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
