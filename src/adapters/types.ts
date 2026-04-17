// ============================================================
// CLI Adapter Types
// Absorb CLI differences via CLIRequest / CLIResponse
// ============================================================

/** Max CLI output buffer size (10MB) */
export const MAX_BUFFER_BYTES = 10 * 1024 * 1024;

/** Tool names that require write permission */
export const WRITE_CAPABLE_TOOLS = ["Write", "Edit", "Bash"] as const;

/** Check if a tool list includes any write-capable tools */
export function hasWriteCapableTools(tools: string[]): boolean {
  return tools.some((t) =>
    WRITE_CAPABLE_TOOLS.some((w) => t === w || t.startsWith(`${w}(`))
  );
}

/** Request passed from lens to CLI execution */
export interface CLIRequest {
  /** Lens system prompt (file path) */
  systemPromptPath: string;

  /** User prompt (combined diff + state + instructions) */
  userPrompt: string;

  /** Working directory (repo root or tempdir) */
  cwd: string;

  /** Allowed tools (adapter converts to CLI-specific format) */
  toolPolicy: ToolPolicy;

  /** Model to use */
  model: string;

  /** Timeout (ms) */
  timeoutMs: number;

  /** Optional: API proxy base URL */
  baseUrl?: string;
}

export type ToolPolicy =
  | { type: "none" }
  | { type: "read_only" }
  | { type: "all" }
  | { type: "explicit"; tools: string[] };

/** Unified response from CLI */
export interface CLIResponse {
  parsed: LensOutput | null;
  rawStdout: string;
  rawStderr: string;
  exitCode: number;
  durationMs: number;
}

/** Common type for each lens JSON output */
export interface LensOutput {
  findings: Finding[];
  overall_assessment: "clean" | "minor_issues" | "significant_issues";
  explored_files?: string[];
  change_summary?: string;
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
  /** Exact replacement code for GitHub suggestion block (simple fixes only) */
  suggestion_diff?: string;
  /** Brief explanation of why this was flagged */
  evidence?: string;
  // Assigned by lens-runner
  lens?: string;
  id?: string;
}

/** Common adapter interface */
export interface CLIAdapter {
  readonly name: string;
  isAvailable(): Promise<boolean>;
  execute(request: CLIRequest): Promise<CLIResponse>;
}
