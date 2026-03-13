import { spawn, execFile } from "child_process";
import { promisify } from "util";
import { readFile } from "fs/promises";
import type {
  CLIAdapter,
  CLIRequest,
  CLIResponse,
  LensOutput,
  ToolPolicy,
} from "./types.js";

const execAsync = promisify(execFile);

export class ClaudeCodeAdapter implements CLIAdapter {
  readonly name = "claude";

  async isAvailable(): Promise<boolean> {
    try {
      await execAsync("claude", ["--version"]);
      return true;
    } catch {
      return false;
    }
  }

  async execute(request: CLIRequest): Promise<CLIResponse> {
    const args = await this.buildArgs(request);
    const start = Date.now();

    return new Promise((resolve) => {
      const child = spawn("claude", args, {
        cwd: request.cwd,
        env: { ...process.env, CLAUDECODE: "" },
        stdio: ["pipe", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";

      child.stdout.on("data", (data) => {
        stdout += data.toString();
      });
      child.stderr.on("data", (data) => {
        stderr += data.toString();
      });

      const timer = setTimeout(() => {
        child.kill("SIGTERM");
      }, request.timeoutMs);

      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({
          parsed: this.parseOutput(stdout),
          rawStdout: stdout,
          rawStderr: stderr,
          exitCode: typeof code === "number" ? code : 1,
          durationMs: Date.now() - start,
        });
      });

      child.on("error", (err) => {
        clearTimeout(timer);
        resolve({
          parsed: null,
          rawStdout: stdout,
          rawStderr: err.message,
          exitCode: 1,
          durationMs: Date.now() - start,
        });
      });

      // Send prompt via stdin (to avoid ARG_MAX limit)
      child.stdin.write(request.userPrompt);
      child.stdin.end();
    });
  }

  private async buildArgs(request: CLIRequest): Promise<string[]> {
    const systemPrompt = await readFile(request.systemPromptPath, "utf-8");

    const args: string[] = [
      "-p",
      "--output-format",
      "json",
      "--model",
      request.model,
      "--system-prompt",
      systemPrompt,
      "--no-session-persistence",
    ];

    args.push(...this.mapToolPolicy(request.toolPolicy));

    return args;
  }

  private mapToolPolicy(policy: ToolPolicy): string[] {
    switch (policy.type) {
      case "none":
        return ["--tools", ""];
      case "read_only":
        return ["--allowedTools", "Read"];
      case "explicit":
        return ["--allowedTools", policy.tools.join(",")];
    }
  }

  private parseOutput(stdout: string): LensOutput | null {
    try {
      // claude -p --output-format json -> { result: "..." }
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

  /** Fallback for when JSON output has surrounding text: extract object with findings key */
  private extractJsonFromText(text: string): LensOutput | null {
    const jsonMatch = text.match(/\{[\s\S]*?"findings"[\s\S]*?\}(?=\s*$)/);
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
