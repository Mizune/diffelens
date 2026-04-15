import { describe, it, expect, afterEach } from "vitest";
import { writeFile, mkdtemp, rm, readFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { injectSkillContent } from "../skill-prompt-injector.js";
import type { ResolvedPrompt } from "../prompt-resolver.js";

let tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs) {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
  tempDirs = [];
});

async function createBasePrompt(content: string): Promise<ResolvedPrompt> {
  const dir = await mkdtemp(join(tmpdir(), "diffelens-inject-test-"));
  tempDirs.push(dir);
  const path = join(dir, "base-prompt.md");
  await writeFile(path, content, "utf-8");
  return {
    absolutePath: path,
    cleanup: async () => {},
  };
}

describe("injectSkillContent", () => {
  it("returns base prompt unchanged when no skill content", async () => {
    const base = await createBasePrompt("Base prompt content.");
    const result = await injectSkillContent(base, undefined, "test");

    expect(result.absolutePath).toBe(base.absolutePath);
  });

  it("creates temp file with combined content when skill content provided", async () => {
    const base = await createBasePrompt("Base prompt content.");
    const result = await injectSkillContent(base, "Skill instructions here.", "test");

    expect(result.absolutePath).not.toBe(base.absolutePath);
    const combined = await readFile(result.absolutePath, "utf-8");
    expect(combined).toContain("Base prompt content.");
    expect(combined).toContain("## Additional Skill Context");
    expect(combined).toContain("Skill instructions here.");

    await result.cleanup();
  });

  it("cleanup removes the temp file", async () => {
    const base = await createBasePrompt("Base.");
    const result = await injectSkillContent(base, "Skill.", "test");

    const tempPath = result.absolutePath;
    await result.cleanup();

    // Verify file is removed (readFile should throw)
    await expect(readFile(tempPath, "utf-8")).rejects.toThrow();
  });
});
