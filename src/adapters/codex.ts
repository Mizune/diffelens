import { execFile } from "child_process";
import { promisify } from "util";
import { readFile } from "fs/promises";
import type {
  CLIAdapter,
  CLIRequest,
  CLIResponse,
  LensOutput,
  ToolPolicy,
} from "./types.js";

const exec = promisify(execFile);

export class CodexAdapter implements CLIAdapter {
  readonly name = "codex";

  async isAvailable(): Promise<boolean> {
    try {
      await exec("codex", ["--version"]);
      return true;
    } catch {
      return false;
    }
  }

  async execute(request: CLIRequest): Promise<CLIResponse> {
    const args = await this.buildArgs(request);
    const start = Date.now();

    try {
      const { stdout, stderr } = await exec("codex", args, {
        cwd: request.cwd,
        timeout: request.timeoutMs,
        env: { ...process.env },
        maxBuffer: 10 * 1024 * 1024,
      });

      return {
        parsed: this.parseOutput(stdout),
        rawStdout: stdout,
        rawStderr: stderr,
        exitCode: 0,
        durationMs: Date.now() - start,
      };
    } catch (error: any) {
      return {
        parsed: this.parseOutput(error.stdout ?? ""),
        rawStdout: error.stdout ?? "",
        rawStderr: error.stderr ?? "",
        exitCode: error.code ?? 1,
        durationMs: Date.now() - start,
      };
    }
  }

  private async buildArgs(request: CLIRequest): Promise<string[]> {
    // Codex にはシステムプロンプト用フラグがないのでプロンプトに埋め込む
    const systemPrompt = await readFile(request.systemPromptPath, "utf-8");

    const fullPrompt = [systemPrompt, "", request.userPrompt].join("\n");

    const args: string[] = [
      "exec",
      "--model",
      request.model,
      "--json",
      "--sandbox",
      this.mapToolPolicy(request.toolPolicy),
      fullPrompt,
    ];

    return args;
  }

  private mapToolPolicy(policy: ToolPolicy): string {
    switch (policy.type) {
      case "none":
        return "read-only";
      case "read_only":
        return "read-only";
      case "explicit":
        if (policy.tools.some((t) => t === "Write" || t.startsWith("Bash"))) {
          return "workspace-write";
        }
        return "workspace-read";
    }
  }

  private parseOutput(stdout: string): LensOutput | null {
    try {
      // Codex --json は JSONL (1行1イベント)
      const lines = stdout.trim().split("\n").filter(Boolean);

      for (const line of lines.reverse()) {
        try {
          const event = JSON.parse(line);
          const content = this.extractContent(event);
          if (content && content.includes('"findings"')) {
            const cleaned = content
              .replace(/^```json\s*/m, "")
              .replace(/\s*```$/m, "")
              .trim();
            return JSON.parse(cleaned);
          }
        } catch {
          continue;
        }
      }
      return null;
    } catch {
      return null;
    }
  }

  private extractContent(event: any): string | null {
    if (event?.type === "message" && event?.role === "assistant") {
      return typeof event.content === "string"
        ? event.content
        : JSON.stringify(event.content);
    }
    if (event?.output) {
      return typeof event.output === "string"
        ? event.output
        : JSON.stringify(event.output);
    }
    // codex exec の最終出力形式に対応
    if (typeof event === "string") return event;
    return null;
  }
}
