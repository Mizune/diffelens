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

export const LOCAL_CONFIG_FILENAME = ".ai-review.local.yaml";

const BUILTIN_LENSES = new Set(["readability", "architectural", "bug_risk"]);

/** Normalize raw config into the final ReviewConfig */
function normalizeRawConfig(raw: RawConfig): ReviewConfig {
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

export async function loadConfig(configPath: string): Promise<ReviewConfig> {
  const content = await readFile(configPath, "utf-8");
  const raw = parseYaml(content) as RawConfig;
  return normalizeRawConfig(raw);
}

/**
 * Deep merge a local overlay config over a base config.
 * - global: field-level merge
 * - lenses: per-lens field-level merge (new lenses are added)
 * - convergence: field-level merge
 * - filters.exclude_patterns: array replacement (not appended)
 */
export function deepMergeRawConfig(base: RawConfig, overlay: Record<string, unknown>): RawConfig {
  const merged = { ...base };

  // global: shallow merge
  if (overlay.global && typeof overlay.global === "object") {
    merged.global = { ...base.global, ...(overlay.global as Partial<RawConfig["global"]>) };
  }

  // lenses: per-lens field-level merge
  if (overlay.lenses && typeof overlay.lenses === "object") {
    const overlayLenses = overlay.lenses as Record<string, Partial<RawLensConfig>>;
    const mergedLenses = { ...base.lenses };
    for (const [name, lensOverlay] of Object.entries(overlayLenses)) {
      if (name in mergedLenses) {
        mergedLenses[name] = { ...mergedLenses[name], ...lensOverlay };
      } else {
        mergedLenses[name] = lensOverlay as RawLensConfig;
      }
    }
    merged.lenses = mergedLenses;
  }

  // convergence: field-level merge
  if (overlay.convergence && typeof overlay.convergence === "object") {
    merged.convergence = {
      ...base.convergence,
      ...(overlay.convergence as Partial<RawConvergenceConfig>),
    };
  }

  // filters: replace exclude_patterns array
  if (overlay.filters && typeof overlay.filters === "object") {
    const overlayFilters = overlay.filters as Partial<RawConfig["filters"]>;
    if (overlayFilters.exclude_patterns) {
      merged.filters = { ...base.filters, exclude_patterns: overlayFilters.exclude_patterns };
    }
  }

  // version: overlay wins if present
  if (overlay.version && typeof overlay.version === "string") {
    merged.version = overlay.version;
  }

  return merged;
}

/**
 * Load config with local overlay support.
 * If localPath exists, deep-merges it over the base config before normalization.
 */
export async function loadConfigWithLocalOverlay(
  basePath: string,
  localPath: string
): Promise<{ config: ReviewConfig; localOverlayApplied: boolean }> {
  const baseContent = await readFile(basePath, "utf-8");
  const baseRaw = parseYaml(baseContent) as RawConfig;

  if (!existsSync(localPath)) {
    return { config: normalizeRawConfig(baseRaw), localOverlayApplied: false };
  }

  const localContent = await readFile(localPath, "utf-8");
  const localRaw = parseYaml(localContent) as Record<string, unknown>;

  if (!localRaw || typeof localRaw !== "object") {
    return { config: normalizeRawConfig(baseRaw), localOverlayApplied: false };
  }

  const merged = deepMergeRawConfig(baseRaw, localRaw);
  return { config: normalizeRawConfig(merged), localOverlayApplied: true };
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
