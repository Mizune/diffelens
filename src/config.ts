import { readFile } from "fs/promises";
import { parse as parseYaml } from "yaml";
import type { CLIName, ToolPolicy } from "./adapters/index.js";

// ============================================================
// .ai-review.yaml の型定義と読み込み
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
  toolPolicy: ToolPolicy;
  maxTurns: number;
  timeoutMs: number;
  isolation: "tempdir" | "repo";
  severityCap: "blocker" | "warning" | "nitpick";
}

export interface ConvergenceConfig {
  round_1_severities: string[];
  round_2_severities: string[];
  round_3_severities: string[];
  approve_condition: "zero_blockers" | "zero_blockers_and_warnings";
}

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
  convergence: ConvergenceConfig;
  filters: { exclude_patterns: string[] };
}

export async function loadConfig(configPath: string): Promise<ReviewConfig> {
  const content = await readFile(configPath, "utf-8");
  const raw = parseYaml(content) as RawConfig;

  const lenses: LensConfig[] = [];

  for (const [name, lens] of Object.entries(raw.lenses)) {
    if (!lens.enabled) continue;

    lenses.push({
      name,
      cli: lens.cli ?? raw.global.default_cli,
      model: lens.model,
      promptFile: `prompts/${name}.md`,
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
    convergence: raw.convergence,
    filters: raw.filters ?? { exclude_patterns: [] },
  };
}

function normalizeToolPolicy(
  raw: "none" | "read_only" | { type: "explicit"; tools: string[] }
): ToolPolicy {
  if (raw === "none") return { type: "none" };
  if (raw === "read_only") return { type: "read_only" };
  return raw;
}
