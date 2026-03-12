import { execFile } from "child_process";
import { promisify } from "util";
import type {
  CLIAdapter,
  CLIRequest,
  CLIResponse,
  LensOutput,
  ToolPolicy,
} from "./types.js";

const exec = promisify(execFile);

export class ClaudeCodeAdapter implements CLIAdapter {
  readonly name = "claude-code";

  async isAvailable(): Promise<boolean> {
    try {
      await exec("claude", ["--version"]);
      return true;
    } catch {
      return false;
    }
  }

  async execute(request: CLIRequest): Promise<CLIResponse> {
    const args = this.buildArgs(request);
    const start = Date.now();

    try {
      const { stdout, stderr } = await exec("claude", args, {
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

  private buildArgs(request: CLIRequest): string[] {
    const args: string[] = [
      "-p",
      "--output-format",
      "json",
      "--model",
      request.model,
      "--max-turns",
      String(request.maxTurns),
      "--system-prompt",
      request.systemPromptPath,
    ];

    args.push(...this.mapToolPolicy(request.toolPolicy));
    args.push(request.userPrompt);

    return args;
  }

  private mapToolPolicy(policy: ToolPolicy): string[] {
    switch (policy.type) {
      case "none":
        // ツール完全無効化
        return ["--allowedTools", ""];
      case "read_only":
        return ["--allowedTools", "Read"];
      case "explicit":
        return ["--allowedTools", policy.tools.join(",")];
    }
  }

  private parseOutput(stdout: string): LensOutput | null {
    try {
      // claude -p --output-format json → { result: "..." }
      const envelope = JSON.parse(stdout);
      const content = envelope.result ?? envelope;

      if (typeof content === "string") {
        const cleaned = content
          .replace(/^```json\s*/m, "")
          .replace(/\s*```$/m, "")
          .trim();
        return JSON.parse(cleaned);
      }

      if (content.findings) {
        return content as LensOutput;
      }

      return null;
    } catch {
      return this.extractJsonFromText(stdout);
    }
  }

  private extractJsonFromText(text: string): LensOutput | null {
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
}
