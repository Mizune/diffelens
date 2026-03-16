import type { ReviewState } from "../state/review-state.js";

// ============================================================
// State embedding/extraction for PR comments (GitHub mode)
// ============================================================

const STATE_MARKER_PREFIX = "<!-- diffelens-state: ";
const STATE_MARKER_SUFFIX = " -->";

/** Embed review state as a hidden marker at the end of the comment body */
export function embedState(body: string, state: ReviewState): string {
  const json = JSON.stringify(state);
  const encoded = Buffer.from(json, "utf-8").toString("base64");
  return `${body}\n${STATE_MARKER_PREFIX}${encoded}${STATE_MARKER_SUFFIX}`;
}

/** Extract review state from comment body. Returns null if no marker found. */
export function extractState(body: string): ReviewState | null {
  const startIdx = body.indexOf(STATE_MARKER_PREFIX);
  if (startIdx === -1) return null;

  const dataStart = startIdx + STATE_MARKER_PREFIX.length;
  const endIdx = body.indexOf(STATE_MARKER_SUFFIX, dataStart);
  if (endIdx === -1) return null;

  const encoded = body.slice(dataStart, endIdx);
  try {
    const json = Buffer.from(encoded, "base64").toString("utf-8");
    return JSON.parse(json) as ReviewState;
  } catch {
    return null;
  }
}
