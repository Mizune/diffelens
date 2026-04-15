import { readFile, writeFile, rm } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import type { LensConfig, SkillConfig } from "./config.js";

// ============================================================
// Prompt Resolution: LensConfig -> absolute prompt file path
// ============================================================

export interface ResolvedPrompt {
  absolutePath: string;
  cleanup: () => Promise<void>;
}

const noop = async () => {};

/**
 * Resolve a lens config to an absolute prompt file path.
 * For "extended" prompts, creates a temp file with combined content.
 */
export async function resolvePrompt(
  config: LensConfig,
  repoRoot: string,
  diffelensRoot: string
): Promise<ResolvedPrompt> {
  switch (config.promptSource) {
    case "builtin":
      return {
        absolutePath: join(diffelensRoot, config.promptFile),
        cleanup: noop,
      };

    case "custom":
      return {
        absolutePath: join(repoRoot, config.promptFile),
        cleanup: noop,
      };

    case "extended": {
      const builtinPath = join(diffelensRoot, config.promptFile);
      const appendPath = join(repoRoot, config.promptAppendFile!);

      const [builtinContent, appendContent] = await Promise.all([
        readFile(builtinPath, "utf-8"),
        readFile(appendPath, "utf-8"),
      ]);

      const combined = `${builtinContent}\n\n${appendContent}`;
      const tempPath = join(
        tmpdir(),
        `diffelens-prompt-${config.name}-${Date.now()}.md`
      );
      await writeFile(tempPath, combined, "utf-8");

      return {
        absolutePath: tempPath,
        cleanup: async () => {
          await rm(tempPath, { force: true }).catch(() => {});
        },
      };
    }
  }
}

/**
 * Validate that all referenced prompt files exist.
 * Throws with all errors at once for a clear error message.
 */
export async function validatePrompts(
  lenses: readonly LensConfig[],
  repoRoot: string,
  diffelensRoot: string
): Promise<void> {
  const errors: string[] = [];

  for (const lens of lenses) {
    switch (lens.promptSource) {
      case "builtin": {
        const path = join(diffelensRoot, lens.promptFile);
        if (!existsSync(path)) {
          errors.push(`Lens "${lens.name}": built-in prompt not found at ${path}`);
        }
        break;
      }
      case "custom": {
        const path = join(repoRoot, lens.promptFile);
        if (!existsSync(path)) {
          errors.push(`Lens "${lens.name}": custom prompt not found at ${path}`);
        }
        break;
      }
      case "extended": {
        const builtinPath = join(diffelensRoot, lens.promptFile);
        if (!existsSync(builtinPath)) {
          errors.push(`Lens "${lens.name}": built-in prompt not found at ${builtinPath}`);
        }
        const appendPath = join(repoRoot, lens.promptAppendFile!);
        if (!existsSync(appendPath)) {
          errors.push(`Lens "${lens.name}": append prompt not found at ${appendPath}`);
        }
        break;
      }
    }
  }

  if (errors.length > 0) {
    throw new Error(`Prompt validation failed:\n  ${errors.join("\n  ")}`);
  }
}

/**
 * Resolve a skill's prompt file to an absolute path.
 * Skill prompts are always custom (repo-relative), no builtin/extended logic.
 */
export function resolveSkillPromptPath(promptFile: string, repoRoot: string): string {
  return join(repoRoot, promptFile);
}

/**
 * Validate that all skill prompt files exist.
 */
export async function validateSkillPrompts(
  skills: readonly SkillConfig[],
  repoRoot: string,
): Promise<void> {
  const errors: string[] = [];

  for (const skill of skills) {
    const path = resolveSkillPromptPath(skill.promptFile, repoRoot);
    if (!existsSync(path)) {
      errors.push(`Skill "${skill.name}": prompt file not found at ${path}`);
    }
  }

  if (errors.length > 0) {
    throw new Error(`Skill prompt validation failed:\n  ${errors.join("\n  ")}`);
  }
}
