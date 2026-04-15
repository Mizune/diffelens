import { readFile } from "fs/promises";
import { existsSync } from "fs";
import { parse as parseYaml } from "yaml";
import type { CLIName, ToolPolicy } from "./adapters/index.js";
import { VALID_SEVERITIES } from "./severity.js";

// ============================================================
// Type definitions and loader for .diffelens.yaml
// ============================================================

export interface GlobalConfig {
  max_rounds: number;
  language: string;
  default_cli: CLIName;
  timeout_ms: number;
  base_url?: string;
}

/** Shared execution fields between lenses and standalone skills */
export interface ExecutionConfig {
  cli: CLIName;
  model: string;
  toolPolicy: ToolPolicy;
  timeoutMs: number;
  isolation: "tempdir" | "repo";
  severityCap: "blocker" | "warning" | "nitpick";
  baseUrl?: string;
}

/** Minimal context needed to execute a review run (used by runLens) */
export interface RunContext extends ExecutionConfig {
  name: string;
}

export interface LensConfig extends RunContext {
  promptFile: string;
  promptSource: "builtin" | "custom" | "extended";
  promptAppendFile?: string;
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

export interface SkillTriggers {
  filePatterns?: string[];
  always?: boolean;
}

interface SkillBase {
  name: string;
  enabled: boolean;
  promptFile: string;
  triggers: SkillTriggers;
}

export interface InjectSkillConfig extends SkillBase {
  mode: "inject";
  attachTo: string[];
}

export interface StandaloneSkillConfig extends SkillBase, ExecutionConfig {
  mode: "standalone";
}

export type SkillConfig = InjectSkillConfig | StandaloneSkillConfig;

export interface GitHubOutputConfig {
  autoApprove: boolean;
  onIssues: "request_changes" | "comment";
}

export interface OutputConfig {
  github: GitHubOutputConfig;
}

export interface ReviewConfig {
  global: GlobalConfig;
  lenses: LensConfig[];
  skills: SkillConfig[];
  convergence: ConvergenceConfig;
  filters: { exclude_patterns: string[] };
  output: OutputConfig;
}

interface RawLensConfig {
  enabled: boolean;
  cli?: CLIName;
  model: string;
  isolation: "tempdir" | "repo";
  tool_policy: "none" | "read_only" | "all" | { type: "explicit"; tools: string[] };
  timeout_ms?: number;
  severity_cap?: "blocker" | "warning" | "nitpick";
  prompt_file?: string;
  prompt_append_file?: string;
  base_url?: string;
}

interface RawSkillConfig {
  enabled: boolean;
  mode: "inject" | "standalone";
  prompt_file: string;
  triggers?: {
    file_patterns?: string[];
    always?: boolean;
  };
  attach_to?: string[];
  cli?: CLIName;
  model?: string;
  isolation?: "tempdir" | "repo";
  tool_policy?: "none" | "read_only" | "all" | { type: "explicit"; tools: string[] };
  timeout_ms?: number;
  severity_cap?: "blocker" | "warning" | "nitpick";
  base_url?: string;
}

interface RawOutputConfig {
  github?: {
    auto_approve?: boolean;
    on_issues?: "request_changes" | "comment";
  };
}

interface RawConfig {
  version: string;
  global: {
    max_rounds: number;
    language: string;
    default_cli: CLIName;
    timeout_ms: number;
    base_url?: string;
  };
  lenses: Record<string, RawLensConfig>;
  skills?: Record<string, RawSkillConfig>;
  convergence: RawConvergenceConfig;
  filters: { exclude_patterns: string[] };
  output?: RawOutputConfig;
}

export const LOCAL_CONFIG_FILENAME = ".diffelens.local.yaml";

const BUILTIN_LENSES = new Set(["readability", "architectural", "bug_risk"]);

/** Validate that a base_url is a valid http(s) URL */
function validateBaseUrl(url: string, context: string): void {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error(`${context}: base_url must use http:// or https://`);
    }
  } catch (e) {
    if (e instanceof TypeError) {
      throw new Error(`${context}: invalid base_url: "${url}"`);
    }
    throw e;
  }
}

/** Normalize raw config into the final ReviewConfig */
function normalizeRawConfig(raw: RawConfig): ReviewConfig {
  const lenses: LensConfig[] = [];

  if (raw.global.base_url) {
    validateBaseUrl(raw.global.base_url, "global");
  }

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

    if (lens.base_url) {
      validateBaseUrl(lens.base_url, `lens "${name}"`);
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
      baseUrl: lens.base_url ?? raw.global.base_url,
    });
  }

  const enabledLensNames = new Set(lenses.map((l) => l.name));
  const allDeclaredLensNames = new Set(Object.keys(raw.lenses));
  const skills = normalizeSkills(raw.skills ?? {}, raw.global, enabledLensNames, allDeclaredLensNames);
  const output = normalizeOutput(raw.output);

  return {
    global: raw.global,
    lenses,
    skills,
    convergence: normalizeConvergence(raw.convergence),
    filters: raw.filters ?? { exclude_patterns: [] },
    output,
  };
}

function validateSkillTriggers(name: string, skill: RawSkillConfig): SkillTriggers {
  const triggers: SkillTriggers = {
    filePatterns: skill.triggers?.file_patterns,
    always: skill.triggers?.always,
  };

  const hasFilePatterns = (triggers.filePatterns?.length ?? 0) > 0;
  if (!hasFilePatterns && triggers.always !== true) {
    throw new Error(
      `Skill "${name}" requires at least one trigger condition (file_patterns or always: true)`
    );
  }

  return triggers;
}

function buildInjectSkill(
  name: string,
  skill: RawSkillConfig,
  triggers: SkillTriggers,
  enabledLensNames: Set<string>,
  allDeclaredLensNames: Set<string>
): InjectSkillConfig {
  if (!skill.attach_to || skill.attach_to.length === 0) {
    throw new Error(`Inject skill "${name}" requires attach_to with at least one lens name`);
  }
  for (const lensName of skill.attach_to) {
    if (!enabledLensNames.has(lensName)) {
      const lensStatus = allDeclaredLensNames.has(lensName) ? "disabled" : "unknown";
      throw new Error(`Inject skill "${name}" targets ${lensStatus} lens "${lensName}" in attach_to`);
    }
  }

  return {
    name,
    enabled: true,
    mode: "inject",
    promptFile: skill.prompt_file,
    triggers,
    attachTo: skill.attach_to,
  };
}

function buildStandaloneSkill(
  name: string,
  skill: RawSkillConfig,
  triggers: SkillTriggers,
  globalConfig: RawConfig["global"]
): StandaloneSkillConfig {
  if (!skill.model) {
    throw new Error(`Standalone skill "${name}" requires a model`);
  }
  if (skill.base_url) {
    validateBaseUrl(skill.base_url, `skill "${name}"`);
  }

  return {
    name,
    enabled: true,
    mode: "standalone",
    promptFile: skill.prompt_file,
    triggers,
    cli: skill.cli ?? globalConfig.default_cli,
    model: skill.model,
    isolation: skill.isolation ?? "repo",
    toolPolicy: skill.tool_policy ? normalizeToolPolicy(skill.tool_policy) : { type: "none" },
    timeoutMs: skill.timeout_ms ?? globalConfig.timeout_ms,
    severityCap: skill.severity_cap ?? "blocker",
    baseUrl: skill.base_url ?? globalConfig.base_url,
  };
}

function normalizeSkills(
  rawSkills: Record<string, RawSkillConfig>,
  globalConfig: RawConfig["global"],
  enabledLensNames: Set<string>,
  allDeclaredLensNames: Set<string>
): SkillConfig[] {
  const skills: SkillConfig[] = [];

  for (const [name, skill] of Object.entries(rawSkills)) {
    if (!skill.enabled) continue;

    if (!skill.prompt_file) {
      throw new Error(`Skill "${name}" requires a prompt_file`);
    }

    const triggers = validateSkillTriggers(name, skill);

    if (skill.mode === "standalone") {
      skills.push(buildStandaloneSkill(name, skill, triggers, globalConfig));
    } else if (skill.mode === "inject") {
      skills.push(buildInjectSkill(name, skill, triggers, enabledLensNames, allDeclaredLensNames));
    } else {
      throw new Error(
        `Skill "${name}" has invalid mode "${skill.mode}". Valid values: inject, standalone`
      );
    }
  }

  return skills;
}

function defaultOutput(): OutputConfig {
  return {
    github: {
      autoApprove: false,
      onIssues: "comment",
    },
  };
}

function normalizeOutput(raw?: RawOutputConfig): OutputConfig {
  if (!raw) return defaultOutput();

  const onIssues = raw.github?.on_issues ?? "comment";
  if (onIssues !== "request_changes" && onIssues !== "comment") {
    throw new Error(
      `Invalid output.github.on_issues: "${onIssues}". Valid values: request_changes, comment`
    );
  }

  return {
    github: {
      autoApprove: raw.github?.auto_approve ?? false,
      onIssues,
    },
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

  // skills: per-skill field-level merge (same pattern as lenses)
  if (overlay.skills && typeof overlay.skills === "object") {
    const overlaySkills = overlay.skills as Record<string, Partial<RawSkillConfig>>;
    const mergedSkills = { ...(base.skills ?? {}) };
    for (const [name, skillOverlay] of Object.entries(overlaySkills)) {
      if (name in mergedSkills) {
        mergedSkills[name] = { ...mergedSkills[name], ...skillOverlay };
      } else {
        mergedSkills[name] = skillOverlay as RawSkillConfig;
      }
    }
    merged.skills = mergedSkills;
  }

  // output: deep merge github sub-object
  if (overlay.output && typeof overlay.output === "object") {
    const overlayOutput = overlay.output as Partial<RawOutputConfig>;
    const baseOutput = base.output ?? {};
    merged.output = {
      ...baseOutput,
      github: {
        ...(baseOutput.github ?? {}),
        ...(overlayOutput.github ?? {}),
      },
    };
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
  raw: "none" | "read_only" | "all" | { type: "explicit"; tools: string[] }
): ToolPolicy {
  if (raw === "none") return { type: "none" };
  if (raw === "read_only") return { type: "read_only" };
  if (raw === "all") return { type: "all" };
  return raw;
}
