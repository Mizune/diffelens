// ============================================================
// CLI Adapter Types
// CLIRequest / CLIResponse でCLI差分を吸収する
// ============================================================

/** CLI出力バッファの上限 (10MB) */
export const MAX_BUFFER_BYTES = 10 * 1024 * 1024;

/** 書き込み権限が必要なツール名 */
export const WRITE_CAPABLE_TOOLS = ["Write", "Edit", "Bash"] as const;

/** レンズからCLI実行に渡すリクエスト */
export interface CLIRequest {
  /** レンズのシステムプロンプト（ファイルパス） */
  systemPromptPath: string;

  /** ユーザープロンプト（diff + state + 指示を結合したもの） */
  userPrompt: string;

  /** 実行ディレクトリ（repo root or tempdir） */
  cwd: string;

  /** 許可するツール（adapter側でCLI固有の形式に変換） */
  toolPolicy: ToolPolicy;

  /** エージェントの最大ターン数 */
  maxTurns: number;

  /** 使用モデル */
  model: string;

  /** タイムアウト（ms） */
  timeoutMs: number;
}

export type ToolPolicy =
  | { type: "none" }
  | { type: "read_only" }
  | { type: "explicit"; tools: string[] };

/** CLIから返る統一レスポンス */
export interface CLIResponse {
  parsed: LensOutput | null;
  rawStdout: string;
  rawStderr: string;
  exitCode: number;
  durationMs: number;
}

/** 各レンズのJSON出力の共通型 */
export interface LensOutput {
  findings: Finding[];
  overall_assessment: "clean" | "minor_issues" | "significant_issues";
  explored_files?: string[];
}

export interface Finding {
  file: string;
  line_start: number;
  line_end: number;
  severity: "blocker" | "warning" | "nitpick";
  category: string;
  summary: string;
  suggestion: string;
  scenario?: string;
  references?: string[];
  // lens-runner が付与
  lens?: string;
  id?: string;
}

/** アダプターの共通インターフェース */
export interface CLIAdapter {
  readonly name: string;
  isAvailable(): Promise<boolean>;
  execute(request: CLIRequest): Promise<CLIResponse>;
}
