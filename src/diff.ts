import { execSync } from "child_process";
import { createHash } from "crypto";
import type { RunOptions, DiffTarget } from "./options.js";

// ============================================================
// Diff Fetching + Hashing
// ============================================================

export function fetchDiff(options: RunOptions): string {
  const command = buildDiffCommand(options);
  return execSync(command, {
    encoding: "utf-8",
    maxBuffer: 5 * 1024 * 1024,
    cwd: options.repoRoot,
  });
}

export function hashDiff(diff: string): string {
  return createHash("sha256").update(diff).digest("hex").slice(0, 12);
}

function buildDiffCommand(options: RunOptions): string {
  if (options.mode === "github") {
    return `git diff ${options.baseSha}...${options.headSha}`;
  }

  return localDiffCommand(options.diffTarget);
}

function localDiffCommand(target: DiffTarget): string {
  switch (target) {
    case "staged":
      return "git diff --cached";
    case "unstaged":
      return "git diff";
    case "all":
      return "git diff HEAD";
    case "branch":
      return "git diff $(git merge-base HEAD main)...HEAD";
    case "commits":
      return "git diff HEAD~1...HEAD";
  }
}
