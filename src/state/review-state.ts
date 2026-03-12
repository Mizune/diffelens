import { readFile, writeFile, mkdir } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";
import type { Finding } from "../adapters/types.js";

// ============================================================
// Review State: PRごとの状態管理
// ============================================================

export interface StateFinding extends Finding {
  id: string;
  lens: string;
  status: "open" | "addressed" | "wontfix" | "dismissed";
  first_raised_round: number;
  last_evaluated_round: number;
  resolution_note: string | null;
}

export interface RoundHistory {
  round: number;
  head_sha: string;
  timestamp: string;
  findings_opened: string[];
  findings_resolved: string[];
}

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
}

const STATE_DIR = ".ai-review-state";

function stateFilePath(prNumber: number): string {
  return join(STATE_DIR, `review-state-pr-${prNumber}.json`);
}

/** 既存のstateを読み込む。なければ新規作成 */
export async function loadOrCreateState(
  prNumber: number,
  baseSha: string,
  headSha: string,
  maxRounds: number
): Promise<ReviewState> {
  const filePath = stateFilePath(prNumber);

  if (existsSync(filePath)) {
    try {
      const content = await readFile(filePath, "utf-8");
      const state = JSON.parse(content) as ReviewState;

      // head_sha が変わっていたら新ラウンド（イミュータブルに新オブジェクト返す）
      if (state.head_sha !== headSha) {
        return {
          ...state,
          current_round: state.current_round + 1,
          head_sha: headSha,
        };
      }

      return state;
    } catch {
      console.warn(`Failed to parse state file, creating new state`);
    }
  }

  return createInitialState(prNumber, baseSha, headSha, maxRounds);
}

function createInitialState(
  prNumber: number,
  baseSha: string,
  headSha: string,
  maxRounds: number
): ReviewState {
  return {
    schema_version: "1.0",
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

/** 新しいfindingsでstateを更新（イミュータブル） */
export function updateState(
  state: ReviewState,
  newFindings: Finding[],
  headSha: string
): ReviewState {
  const round = state.current_round;
  const opened: string[] = [];
  const resolved: string[] = [];

  // 既存のopen findingsを評価: 新findingsに含まれていなければ addressed
  const updatedFindings = state.findings.map((existing) => {
    if (existing.status !== "open") return existing;

    const stillExists = newFindings.some(
      (nf) =>
        nf.file === existing.file &&
        nf.category === existing.category &&
        linesOverlap(
          nf.line_start,
          nf.line_end,
          existing.line_start,
          existing.line_end
        )
    );

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

  // 新しいfindingsを追加（既存にマッチしないもの）
  const addedFindings: StateFinding[] = [];
  for (const nf of newFindings) {
    const existingMatch = updatedFindings.find(
      (ef) =>
        ef.status === "open" &&
        ef.file === nf.file &&
        ef.category === nf.category &&
        linesOverlap(
          nf.line_start,
          nf.line_end,
          ef.line_start,
          ef.line_end
        )
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

  // ラウンド履歴追加
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

/** stateをファイルに保存 */
export async function saveState(state: ReviewState): Promise<void> {
  await mkdir(STATE_DIR, { recursive: true });
  const filePath = stateFilePath(state.pr_number);
  await writeFile(filePath, JSON.stringify(state, null, 2), "utf-8");
  console.log(`  State saved → ${filePath}`);
}

// ---- Helpers (exported for testing) ----

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
