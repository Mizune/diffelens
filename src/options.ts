import { dirname, resolve, join } from "path";
import { fileURLToPath } from "url";

// ============================================================
// Run Options: CLI arg parsing + mode detection
// ============================================================

export type DiffTarget = "staged" | "unstaged" | "all" | "branch" | "commits";

export interface RunOptions {
  mode: "github" | "local";
  prNumber: number;
  baseSha: string;
  headSha: string;
  repoRoot: string;
  diffelensRoot: string;
  configPath: string;
  stateDir: string;
  diffTarget: DiffTarget;
}

export function resolveOptions(): RunOptions {
  const args = process.argv.slice(2);

  const mode = parseArg(args, "--mode") ?? detectMode();
  const diffTarget = (parseArg(args, "--diff-target") ?? "all") as DiffTarget;
  const stateDir = parseArg(args, "--state-dir") ?? defaultStateDir(mode);
  const configPath = parseArg(args, "--config") ?? (process.env.CONFIG_PATH ?? ".ai-review.yaml");

  const diffelensRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const repoRoot = process.cwd();

  if (mode === "github") {
    return {
      mode: "github",
      prNumber: parseInt(process.env.PR_NUMBER ?? "0"),
      baseSha: process.env.BASE_SHA ?? "",
      headSha: process.env.HEAD_SHA ?? "",
      repoRoot,
      diffelensRoot,
      configPath,
      stateDir,
      diffTarget,
    };
  }

  return {
    mode: "local",
    prNumber: 0,
    baseSha: "",
    headSha: "",
    repoRoot,
    diffelensRoot,
    configPath,
    stateDir,
    diffTarget,
  };
}

function detectMode(): "github" | "local" {
  return process.env.PR_NUMBER ? "github" : "local";
}

function defaultStateDir(mode: string): string {
  return mode === "github" ? ".ai-review-state" : ".ai-review-state";
}

function parseArg(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index === -1 || index + 1 >= args.length) return undefined;
  return args[index + 1];
}
