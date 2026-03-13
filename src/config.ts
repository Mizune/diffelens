import { readFile } from "fs/promises";
import { existsSync } from "fs";
import { parse as parseYaml } from "yaml";
import type { CLIName, ToolPolicy } from "./adapters/index.js";
import { VALID_SEVERITIES } from "./severity.js";

// ============================================================
// Type definitions and loader for .ai-review.yaml
// ============================================================

export interface GlobalConfig {
  max_rounds: number;
  language: string;
  default_cli: CLIName;
  timeout_ms: number;
}

export interface LensConfig {
  name: string;
  cli: CLIName;
  model: string;
  promptFile: string;
  promptSource: "builtin" | "custom" | "extended";
  promptAppendFile?: string;
  toolPolicy: ToolPolicy;
  maxTurns: number;
  timeoutMs: number;
  isolation: "tempdir" | "repo";
  severityCap: "blocker" | "warning" | "nitpick";
}

export interface ConvergenceConfig {
  round_severities: string[][];
  approve_condition: "zero_blockers" | "zero_blockers_and_warnings";
}

type ApproveCondition = "zero_blockers" | "zero_blockers_and_warnings";

interface RawConvergenceLegacy {
  round_1_severities: string[];
  round_2_severities: string[];
  round_3_severities: string[];
  approve_condition: ApproveCondition;
}

interface RawConvergenceNew {
  round_severities: string[][];
  approve_condition: ApproveCondition;
}

type RawConvergenceConfig = RawConvergenceLegacy | RawConvergenceNew;

export interface ReviewConfig {
  global: GlobalConfig;
  lenses: LensConfig[];
  convergence: ConvergenceConfig;
  filters: { exclude_patterns: string[] };
}

interface RawLensConfig {
  enabled: boolean;
  cli?: CLIName;
  model: string;
  isolation: "tempdir" | "repo";
  max_turns: number;
  tool_policy: "none" | "read_only" | { type: "explicit"; tools: string[] };
  timeout_ms?: number;
  severity_cap?: "blocker" | "warning" | "nitpick";
  prompt_file?: string;
  prompt_append_file?: string;
}

interface RawConfig {
  version: string;
  global: {
    max_rounds: number;
    language: string;
    default_cli: CLIName;
    timeout_ms: number;
  };
  lenses: Record<string, RawLensConfig>;
  convergence: RawConvergenceConfig;
  filters: { exclude_patterns: string[] };
}

const BUILTIN_LENSES = new Set(["readability", "architectural", "bug_risk"]);

export async function loadConfig(configPath: string): Promise<ReviewConfig> {
  const content = await readFile(configPath, "utf-8");
  const raw = parseYaml(content) as RawConfig;

  const lenses: LensConfig[] = [];

  for (const [name, lens] of Object.entries(raw.lenses)) {
    if (!lens.enabled) continue;

    if (lens.prompt_file && lens.prompt_append_file) {
      throw new Error(
        `Lens "${name}": prompt_file and prompt_append_file are mutually exclusive`
      );
    }

    const isBuiltin = BUILTIN_LENSES.has(name);

    if (!isBuiltin && !lens.prompt_file) {
      throw new Error(
        `Custom lens "${name}" requires a prompt_file`
      );
    }

    const { promptFile, promptSource, promptAppendFile } = resolvePromptConfig(
      name,
      isBuiltin,
      lens.prompt_file,
      lens.prompt_append_file
    );

    lenses.push({
      name,
      cli: lens.cli ?? raw.global.default_cli,
      model: lens.model,
      promptFile,
      promptSource,
      promptAppendFile,
      toolPolicy: normalizeToolPolicy(lens.tool_policy),
      maxTurns: lens.max_turns,
      timeoutMs: lens.timeout_ms ?? raw.global.timeout_ms,
      isolation: lens.isolation,
      severityCap: lens.severity_cap ?? "blocker",
    });
  }

  return {
    global: raw.global,
    lenses,
    convergence: normalizeConvergence(raw.convergence),
    filters: raw.filters ?? { exclude_patterns: [] },
  };
}

function resolvePromptConfig(
  name: string,
  isBuiltin: boolean,
  promptFile?: string,
  promptAppendFile?: string
): Pick<LensConfig, "promptFile" | "promptSource" | "promptAppendFile"> {
  if (promptFile) {
    return {
      promptFile: promptFile,
      promptSource: "custom",
      promptAppendFile: undefined,
    };
  }

  if (promptAppendFile) {
    return {
      promptFile: `prompts/${name}.md`,
      promptSource: "extended",
      promptAppendFile,
    };
  }

  // Default: builtin (only reached for built-in lenses due to validation above)
  return {
    promptFile: `prompts/${name}.md`,
    promptSource: "builtin",
    promptAppendFile: undefined,
  };
}

/**
 * Load config from primary path, falling back to a default path if primary doesn't exist.
 */
export async function loadConfigWithFallback(
  configPath: string,
  fallbackPath: string
): Promise<ReviewConfig> {
  if (existsSync(configPath)) {
    return loadConfig(configPath);
  }
  return loadConfig(fallbackPath);
}

function normalizeConvergence(raw: RawConvergenceConfig): ConvergenceConfig {
  if ("round_severities" in raw) {
    validateRoundSeverities(raw.round_severities);
    return {
      round_severities: raw.round_severities,
      approve_condition: raw.approve_condition,
    };
  }

  const roundSeverities = [
    raw.round_1_severities,
    raw.round_2_severities,
    raw.round_3_severities,
  ];
  validateRoundSeverities(roundSeverities);
  return {
    round_severities: roundSeverities,
    approve_condition: raw.approve_condition,
  };
}

function validateRoundSeverities(roundSeverities: string[][]): void {
  if (roundSeverities.length === 0) {
    throw new Error("round_severities must not be empty");
  }

  for (let i = 0; i < roundSeverities.length; i++) {
    const entry = roundSeverities[i];
    if (entry.length === 0) {
      throw new Error(`round_severities[${i}] must not be empty`);
    }
    for (const severity of entry) {
      if (!VALID_SEVERITIES.has(severity)) {
        throw new Error(
          `Invalid severity "${severity}" in round_severities[${i}]. Valid values: ${[...VALID_SEVERITIES].join(", ")}`
        );
      }
    }
  }
}

function normalizeToolPolicy(
  raw: "none" | "read_only" | { type: "explicit"; tools: string[] }
): ToolPolicy {
  if (raw === "none") return { type: "none" };
  if (raw === "read_only") return { type: "read_only" };
  return raw;
}
