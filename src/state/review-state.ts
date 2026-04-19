import { readFile, writeFile, mkdir } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";
import type { Finding } from "../adapters/types.js";

// ============================================================
// Review State: per-PR state management
// ============================================================

export interface StateFinding extends Finding {
  id: string;
  lens: string;
  status: "open" | "addressed" | "wontfix" | "dismissed";
  first_raised_round: number;
  last_evaluated_round: number;
  resolution_note: string | null;
  /** GitHub review comment ID (if posted as inline comment) */
  inline_comment_id?: number;
}

export interface RoundHistory {
  round: number;
  head_sha: string;
  timestamp: string;
  findings_opened: string[];
  findings_resolved: string[];
}

export interface RecurrenceSuppression {
  originalFindingId: string;
  suppressedAtRound: number;
  file: string;
  category: string;
  suppressedSummary?: string;
}

/** Minimal shape for finding location matching */
export type FindingLocation = Pick<Finding, "file" | "line_start" | "line_end" | "category">;

export interface ReviewState {
  schema_version: string;
  pr_number: number;
  repository: string;
  current_round: number;
  max_rounds: number;
  base_sha: string;
  head_sha: string;
  findings: StateFinding[];
  round_history: RoundHistory[];
  decisions: string[];
  recurrence_suppressions?: RecurrenceSuppression[];
  /** Commit SHA when inline comments were last posted */
  last_inline_review_sha?: string;
}

function stateFilePath(stateDir: string, stateKey: string): string {
  return join(stateDir, `review-state-${stateKey}.json`);
}

function buildStateKey(prNumber: number): string {
  return prNumber === 0 ? "local" : `pr-${prNumber}`;
}

/** Load existing state. Returns null if not found. */
export async function loadState(
  stateDir: string,
  prNumber: number
): Promise<ReviewState | null> {
  const filePath = stateFilePath(stateDir, buildStateKey(prNumber));
  if (!existsSync(filePath)) return null;

  try {
    const content = await readFile(filePath, "utf-8");
    return JSON.parse(content) as ReviewState;
  } catch {
    return null;
  }
}

/** Load existing state or create a new one. */
export async function loadOrCreateState(
  stateDir: string,
  prNumber: number,
  baseSha: string,
  headSha: string,
  maxRounds: number
): Promise<ReviewState> {
  const filePath = stateFilePath(stateDir, buildStateKey(prNumber));

  if (existsSync(filePath)) {
    try {
      const content = await readFile(filePath, "utf-8");
      const state = JSON.parse(content) as ReviewState;
      return advanceRoundIfNeeded(state, headSha);
    } catch {
      console.warn(`Failed to parse state file, creating new state`);
    }
  }

  return createInitialState(prNumber, baseSha, headSha, maxRounds);
}

export function createInitialState(
  prNumber: number,
  baseSha: string,
  headSha: string,
  maxRounds: number
): ReviewState {
  return {
    schema_version: "1.1",
    pr_number: prNumber,
    repository: process.env.GITHUB_REPOSITORY ?? "unknown",
    current_round: 1,
    max_rounds: maxRounds,
    base_sha: baseSha,
    head_sha: headSha,
    findings: [],
    round_history: [],
    decisions: [],
  };
}

/** Advance round if head_sha changed (immutable) */
export function advanceRoundIfNeeded(
  state: ReviewState,
  headSha: string
): ReviewState {
  if (state.head_sha !== headSha) {
    return {
      ...state,
      current_round: state.current_round + 1,
      head_sha: headSha,
    };
  }
  return state;
}

/** Update state with new findings (immutable) */
export function updateState(
  state: ReviewState,
  newFindings: Finding[],
  headSha: string
): ReviewState {
  const round = state.current_round;
  const opened: string[] = [];
  const resolved: string[] = [];

  // Evaluate existing open findings: mark as addressed if not in new findings
  const updatedFindings = state.findings.map((existing) => {
    if (existing.status !== "open") return existing;

    const stillExists = newFindings.some((nf) => findingsMatch(nf, existing));

    if (!stillExists) {
      resolved.push(existing.id);
      return {
        ...existing,
        status: "addressed" as const,
        last_evaluated_round: round,
        resolution_note: `Resolved in round ${round} (head: ${headSha.slice(0, 7)})`,
      };
    }

    return {
      ...existing,
      last_evaluated_round: round,
    };
  });

  // Add new findings (those that don't match existing ones)
  const addedFindings: StateFinding[] = [];
  for (const nf of newFindings) {
    const existingMatch = updatedFindings.find(
      (ef) => ef.status === "open" && findingsMatch(nf, ef)
    );

    if (!existingMatch) {
      const id = generateFindingId(nf.lens ?? "unknown", updatedFindings.length + addedFindings.length);
      const stateFinding: StateFinding = {
        ...nf,
        id,
        lens: nf.lens ?? "unknown",
        status: "open",
        first_raised_round: round,
        last_evaluated_round: round,
        resolution_note: null,
      };
      addedFindings.push(stateFinding);
      opened.push(id);
    }
  }

  const allFindings = [...updatedFindings, ...addedFindings];

  // Add round history entry
  const newRoundHistory: RoundHistory = {
    round,
    head_sha: headSha,
    timestamp: new Date().toISOString(),
    findings_opened: opened,
    findings_resolved: resolved,
  };

  return {
    ...state,
    head_sha: headSha,
    findings: allFindings,
    round_history: [...state.round_history, newRoundHistory],
  };
}

/** Save state to file */
export async function saveState(
  stateDir: string,
  state: ReviewState
): Promise<void> {
  await mkdir(stateDir, { recursive: true });
  const filePath = stateFilePath(stateDir, buildStateKey(state.pr_number));
  await writeFile(filePath, JSON.stringify(state, null, 2), "utf-8");
  console.log(`  State saved → ${filePath}`);
}

// ---- Helpers (exported for reuse and testing) ----

/** Check if two findings refer to the same location: file + category + overlapping lines */
export function findingsMatch(a: FindingLocation, b: FindingLocation): boolean {
  return (
    a.file === b.file &&
    a.category === b.category &&
    linesOverlap(a.line_start, a.line_end, b.line_start, b.line_end)
  );
}

export function linesOverlap(
  aStart: number,
  aEnd: number,
  bStart: number,
  bEnd: number
): boolean {
  return aStart <= bEnd && bStart <= aEnd;
}

export function generateFindingId(lens: string, index: number): string {
  const prefix = lens.charAt(0); // r, s, b
  return `${prefix}-${String(index + 1).padStart(3, "0")}`;
}

/** Derive findingId → inline comment ID map from findings (single source of truth) */
export function buildInlineCommentMap(
  findings: readonly StateFinding[]
): Record<string, number> {
  const map: Record<string, number> = {};
  for (const f of findings) {
    if (f.inline_comment_id != null) {
      map[f.id] = f.inline_comment_id;
    }
  }
  return map;
}

/** Merge recurrence suppression history into state (immutable, deduped by originalFindingId) */
export function applyRecurrenceSuppressions(
  state: ReviewState,
  directives: readonly {
    originalFindingId: string;
    file: string;
    category: string;
    suppressedSummary?: string;
  }[]
): ReviewState {
  if (directives.length === 0) return state;

  const existing = state.recurrence_suppressions ?? [];
  const existingIds = new Set(existing.map((s) => s.originalFindingId));

  const newSuppressions: RecurrenceSuppression[] = directives
    .filter((d) => !existingIds.has(d.originalFindingId))
    .map((d) => ({
      originalFindingId: d.originalFindingId,
      suppressedAtRound: state.current_round,
      file: d.file,
      category: d.category,
      suppressedSummary: d.suppressedSummary,
    }));

  return {
    ...state,
    recurrence_suppressions: [...existing, ...newSuppressions],
  };
}
