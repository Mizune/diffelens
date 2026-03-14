import type { LensOutput } from "./types.js";

/** Remove markdown ```json ... ``` code fences from a string */
export function stripCodeFences(text: string): string {
  return text
    .replace(/^```json\s*/m, "")
    .replace(/\s*```$/m, "")
    .trim();
}

/** Fallback: extract a JSON object containing a "findings" key from mixed text */
export function extractJsonFromText(text: string): LensOutput | null {
  const jsonMatch = text.match(/\{[\s\S]*"findings"[\s\S]*\}/);
  if (jsonMatch) {
    try {
      return JSON.parse(jsonMatch[0]);
    } catch {
      return null;
    }
  }
  return null;
}
