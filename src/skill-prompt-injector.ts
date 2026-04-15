import { readFile, writeFile, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import type { ResolvedPrompt } from "./prompt-resolver.js";

// ============================================================
// Skill Prompt Injection: augment lens prompts with skill content
// ============================================================

/**
 * Wrap a resolved prompt to append skill injection content.
 * If no skill content is provided, returns the base prompt unchanged.
 * Otherwise, creates a temp file with the combined content.
 */
export async function injectSkillContent(
  basePrompt: ResolvedPrompt,
  skillContent: string | undefined,
  lensName: string,
): Promise<ResolvedPrompt> {
  if (!skillContent) return basePrompt;

  const baseContent = await readFile(basePrompt.absolutePath, "utf-8");
  const combined = `${baseContent}\n\n## Additional Skill Context\n\n${skillContent}`;

  const tempPath = join(
    tmpdir(),
    `diffelens-skill-${lensName}-${Date.now()}.md`
  );
  await writeFile(tempPath, combined, "utf-8");

  const baseCleanup = basePrompt.cleanup;
  return {
    absolutePath: tempPath,
    cleanup: async () => {
      await rm(tempPath, { force: true }).catch(() => {});
      await baseCleanup().catch(() => {});
    },
  };
}
