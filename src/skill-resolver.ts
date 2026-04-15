import { readFile } from "fs/promises";
import { globToRegex } from "./filters.js";
import { resolveSkillPromptPath } from "./prompt-resolver.js";
import type { ReviewConfig, StandaloneSkillConfig, SkillTriggers } from "./config.js";

// ============================================================
// Skill Resolution: evaluate triggers + build injections/standalone
// ============================================================

/** Prefix used to distinguish standalone skill names from lens names */
export const SKILL_NAME_PREFIX = "skill:";

export interface ResolvedSkills {
  /** Map of lens name -> concatenated inject prompt content */
  injections: Map<string, string>;
  /** Standalone skills that matched triggers (ready to run via runLens) */
  standaloneSkills: StandaloneSkillConfig[];
  /** Names of activated skills (for logging) */
  activatedSkills: string[];
}

/**
 * Evaluate whether a skill's triggers match the current diff files.
 */
export function evaluateTriggers(
  triggers: SkillTriggers,
  diffFiles: string[],
): boolean {
  if (triggers.always) return true;

  if (triggers.filePatterns && triggers.filePatterns.length > 0) {
    const regexes = triggers.filePatterns.map(globToRegex);
    return diffFiles.some((file) =>
      regexes.some((re) => re.test(file))
    );
  }

  return false;
}

/**
 * Resolve all enabled skills:
 * - Evaluate triggers against diff files
 * - Read inject skill prompt files and group by target lens
 * - Collect standalone skills that matched triggers
 */
export async function resolveSkills(
  config: ReviewConfig,
  diffFiles: string[],
  repoRoot: string,
): Promise<ResolvedSkills> {
  const injections = new Map<string, string>();
  const standaloneSkills: StandaloneSkillConfig[] = [];
  const activatedSkills: string[] = [];

  for (const skill of config.skills) {
    if (!skill.enabled) continue;
    if (!evaluateTriggers(skill.triggers, diffFiles)) continue;

    activatedSkills.push(skill.name);

    if (skill.mode === "inject") {
      const content = await readSkillPrompt(skill.promptFile, repoRoot);
      for (const lensName of skill.attachTo ?? []) {
        const existing = injections.get(lensName) ?? "";
        const separator = existing ? "\n\n---\n\n" : "";
        injections.set(lensName, `${existing}${separator}${content}`);
      }
    } else {
      standaloneSkills.push(skill);
    }
  }

  return { injections, standaloneSkills, activatedSkills };
}

/** Build the display name for a standalone skill (prefixed for output distinction) */
export function skillRunName(skillName: string): string {
  return `${SKILL_NAME_PREFIX}${skillName}`;
}

async function readSkillPrompt(promptFile: string, repoRoot: string): Promise<string> {
  const absolutePath = resolveSkillPromptPath(promptFile, repoRoot);
  return readFile(absolutePath, "utf-8");
}
