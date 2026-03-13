import { readFile, access } from "fs/promises";
import { join } from "path";

// ============================================================
// Project Context: collect repo metadata for lens prompts
// ============================================================

export interface ProjectContext {
  language: string | null;
  claudeMd: string | null;
  agentsMd: string | null;
}

const CLAUDE_MD_MAX_CHARS = 2000;
const AGENTS_MD_MAX_CHARS = 1500;

/** Manifest files mapped to their detected language. */
const LANGUAGE_MANIFESTS: ReadonlyArray<{
  file: string;
  language: string;
  /** If set, check for this dependency in a package.json to refine the result. */
  refineDep?: { key: string; language: string };
}> = [
  {
    file: "tsconfig.json",
    language: "TypeScript",
  },
  {
    file: "package.json",
    language: "JavaScript",
    refineDep: { key: "typescript", language: "TypeScript" },
  },
  { file: "go.mod", language: "Go" },
  { file: "Cargo.toml", language: "Rust" },
  { file: "pyproject.toml", language: "Python" },
  { file: "pubspec.yaml", language: "Dart/Flutter" },
];

/**
 * Read a file and truncate at a line boundary if it exceeds maxChars.
 * Returns null when the file does not exist.
 */
export async function readAndTruncate(
  filePath: string,
  maxChars: number
): Promise<string | null> {
  try {
    await access(filePath);
  } catch {
    return null;
  }

  const content = await readFile(filePath, "utf-8");

  if (content.length <= maxChars) {
    return content;
  }

  // Truncate at the last newline before maxChars
  const truncated = content.slice(0, maxChars);
  const lastNewline = truncated.lastIndexOf("\n");
  const cutPoint = lastNewline > 0 ? lastNewline : maxChars;

  return content.slice(0, cutPoint) + "\n\n... (truncated)";
}

/**
 * Detect the primary programming language by probing manifest files.
 */
export async function detectLanguage(
  repoRoot: string
): Promise<string | null> {
  for (const manifest of LANGUAGE_MANIFESTS) {
    const filePath = join(repoRoot, manifest.file);
    try {
      await access(filePath);
    } catch {
      continue;
    }

    // Refine: e.g. package.json with typescript dep → TypeScript
    if (manifest.refineDep && manifest.file === "package.json") {
      try {
        const raw = await readFile(filePath, "utf-8");
        const pkg = JSON.parse(raw);
        const allDeps = {
          ...pkg.dependencies,
          ...pkg.devDependencies,
        };
        if (allDeps[manifest.refineDep.key]) {
          return manifest.refineDep.language;
        }
      } catch {
        // JSON parse failure — fall through to base language
      }
    }

    return manifest.language;
  }

  return null;
}

/**
 * Collect project context from the repository root.
 * When languageOverride is provided, automatic detection is skipped.
 */
export async function collectProjectContext(
  repoRoot: string,
  languageOverride: string | null
): Promise<ProjectContext> {
  const [language, claudeMd, agentsMd] = await Promise.all([
    languageOverride ? Promise.resolve(languageOverride) : detectLanguage(repoRoot),
    readAndTruncate(join(repoRoot, "CLAUDE.md"), CLAUDE_MD_MAX_CHARS),
    readAndTruncate(join(repoRoot, "AGENTS.md"), AGENTS_MD_MAX_CHARS),
  ]);

  return { language, claudeMd, agentsMd };
}

/**
 * Format collected context into a markdown section for injection into user prompts.
 * Returns empty string when no context is available (backward-compatible).
 */
export function formatProjectContext(ctx: ProjectContext): string {
  if (!ctx.language && !ctx.claudeMd && !ctx.agentsMd) {
    return "";
  }

  const sections: string[] = ["## Project Context"];

  if (ctx.language) {
    sections.push(`**Language/Framework**: ${ctx.language}`);
  }

  if (ctx.claudeMd) {
    sections.push(
      "",
      "### Project Guidelines (CLAUDE.md)",
      ctx.claudeMd
    );
  }

  if (ctx.agentsMd) {
    sections.push(
      "",
      "### Agent Guidelines (AGENTS.md)",
      ctx.agentsMd
    );
  }

  return sections.join("\n");
}
