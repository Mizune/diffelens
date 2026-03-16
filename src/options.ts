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
  configExplicit: boolean;
  stateDir: string;
  diffTarget: DiffTarget;
  cliBase: string | undefined;
  cliHead: string | undefined;
}

// Reject shell metacharacters to prevent command injection
export function validateGitRef(ref: string): boolean {
  return ref.length > 0 && !/[;&|`$(){}!<>\n\r]/.test(ref);
}

export function resolveOptions(): RunOptions {
  const args = process.argv.slice(2);

  const mode = parseArg(args, "--mode") ?? detectMode();
  const explicitDiffTarget = parseArg(args, "--diff-target");
  const diffTarget = (explicitDiffTarget ?? "all") as DiffTarget;
  const stateDir = parseArg(args, "--state-dir") ?? defaultStateDir(mode);
  const explicitConfig = parseArg(args, "--config") ?? process.env.CONFIG_PATH;
  const configPath = explicitConfig ?? ".diffelens.yaml";
  const configExplicit = explicitConfig !== undefined;

  const cliBase = parseArg(args, "--base");
  const cliHead = parseArg(args, "--head");

  if (cliBase !== undefined && !validateGitRef(cliBase)) {
    console.error(`Invalid git ref for --base: "${cliBase}"`);
    process.exit(1);
  }
  if (cliHead !== undefined && !validateGitRef(cliHead)) {
    console.error(`Invalid git ref for --head: "${cliHead}"`);
    process.exit(1);
  }

  if (explicitDiffTarget && (cliBase || cliHead)) {
    console.warn("--base/--head provided; --diff-target will be ignored");
  }

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
      configExplicit,
      stateDir,
      diffTarget,
      cliBase,
      cliHead,
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
    configExplicit,
    stateDir,
    diffTarget,
    cliBase,
    cliHead,
  };
}

function detectMode(): "github" | "local" {
  return process.env.PR_NUMBER ? "github" : "local";
}

function defaultStateDir(mode: string): string {
  return mode === "github" ? ".diffelens-state" : ".diffelens-state";
}

function parseArg(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index === -1 || index + 1 >= args.length) return undefined;
  return args[index + 1];
}
