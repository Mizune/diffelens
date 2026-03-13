// ============================================================
// Diff Filtering: exclude files matching exclude_patterns
// ============================================================

/**
 * Convert a glob pattern to a regular expression.
 * `**\/` is treated as "any directory prefix (including empty)".
 */
export function globToRegex(pattern: string): RegExp {
  // 1. Replace **/ and ** with tokens (\x00, \x01 are control chars not present in input)
  let result = pattern
    .replace(/\*\*\//g, "\x00")
    .replace(/\*\*/g, "\x01");

  // 2. Escape regex metacharacters (keep * and ? for glob conversion)
  result = result.replace(/[.+^${}()|[\]\\]/g, "\\$&");

  // 3. Glob -> regex
  result = result
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]")
    .replace(/\x00/g, "(.+/)?")
    .replace(/\x01/g, ".*");

  return new RegExp(`^${result}$`);
}

/**
 * Parse a unified diff and exclude hunks for files matching exclude_patterns.
 */
export function filterDiffByExcludePatterns(diff: string, patterns: string[]): string {
  if (patterns.length === 0) return diff;

  const regexes = patterns.map(globToRegex);

  const shouldExclude = (filePath: string): boolean =>
    regexes.some((re) => re.test(filePath));

  // Split unified diff at "diff --git" boundaries
  const chunks = diff.split(/^(?=diff --git )/m);
  const kept = chunks.filter((chunk) => {
    const headerMatch = chunk.match(/^diff --git a\/(.+?) b\/(.+)/);
    if (!headerMatch) return true; // Keep if not a diff header
    const filePath = headerMatch[2];
    return !shouldExclude(filePath);
  });

  return kept.join("");
}
