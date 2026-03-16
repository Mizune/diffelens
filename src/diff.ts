import { execSync } from "child_process";
import { createHash } from "crypto";
import type { RunOptions, DiffTarget } from "./options.js";

// ============================================================
// Diff Fetching + Hashing + Stats
// ============================================================

export interface DiffStats {
  files: number;
  additions: number;
  deletions: number;
}

/** Parse unified diff to count files, additions, and deletions */
export function parseDiffStats(diff: string): DiffStats {
  let files = 0;
  let additions = 0;
  let deletions = 0;

  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      files++;
    } else if (line.startsWith("+") && !line.startsWith("+++")) {
      additions++;
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      deletions++;
    }
  }

  return { files, additions, deletions };
}

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

export function resolveGitRef(ref: string, cwd: string): string {
  return execSync(`git rev-parse ${ref}`, {
    encoding: "utf-8",
    cwd,
  }).trim();
}

export function detectDefaultBranch(cwd: string): string {
  try {
    const ref = execSync("git symbolic-ref refs/remotes/origin/HEAD", {
      encoding: "utf-8",
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    // refs/remotes/origin/main → main
    return ref.replace("refs/remotes/origin/", "");
  } catch {
    return "main";
  }
}

export function buildDiffCommand(options: RunOptions): string {
  if (options.mode === "github") {
    return `git diff ${options.baseSha}...${options.headSha}`;
  }

  const defaultBranch = detectDefaultBranch(options.repoRoot);

  if (options.cliBase || options.cliHead) {
    return buildRefDiffCommand(options.cliBase, options.cliHead, defaultBranch);
  }

  return localDiffCommand(options.diffTarget, defaultBranch);
}

export function buildRefDiffCommand(
  base: string | undefined,
  head: string | undefined,
  defaultBranch: string = "main"
): string {
  if (base && head) {
    return `git diff ${base}...${head}`;
  }
  if (head) {
    return `git diff $(git merge-base ${head} ${defaultBranch})...${head}`;
  }
  // base only — diff from base to current HEAD
  return `git diff ${base}...HEAD`;
}

function localDiffCommand(target: DiffTarget, defaultBranch: string): string {
  switch (target) {
    case "staged":
      return "git diff --cached";
    case "unstaged":
      return "git diff";
    case "all":
      return "git diff HEAD";
    case "branch":
      return `git diff $(git merge-base HEAD ${defaultBranch})...HEAD`;
    case "commits":
      return "git diff HEAD~1...HEAD";
  }
}
