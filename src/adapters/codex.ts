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
import { MAX_BUFFER_BYTES, WRITE_CAPABLE_TOOLS } from "./types.js";

const execAsync = promisify(execFile);

export class CodexAdapter implements CLIAdapter {
  readonly name = "codex";

  async isAvailable(): Promise<boolean> {
    try {
      await execAsync("codex", ["--version"]);
      return true;
    } catch {
      return false;
    }
  }

  async execute(request: CLIRequest): Promise<CLIResponse> {
    const { args, fullPrompt } = await this.buildArgs(request);
    const start = Date.now();

    return new Promise((resolve) => {
      const child = spawn("codex", args, {
        cwd: request.cwd,
        env: { ...process.env },
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
      child.stdin.write(fullPrompt);
      child.stdin.end();
    });
  }

  private async buildArgs(
    request: CLIRequest
  ): Promise<{ args: string[]; fullPrompt: string }> {
    // Codex has no system prompt flag, so embed it in the prompt
    const systemPrompt = await readFile(request.systemPromptPath, "utf-8");
    const fullPrompt = [systemPrompt, "", request.userPrompt].join("\n");

    const args: string[] = [
      "exec",
      "--model",
      request.model,
      "--json",
      "--sandbox",
      this.mapToolPolicy(request.toolPolicy),
    ];

    return { args, fullPrompt };
  }

  private mapToolPolicy(policy: ToolPolicy): string {
    switch (policy.type) {
      case "none":
        return "read-only";
      case "read_only":
        return "read-only";
      case "explicit":
        if (policy.tools.some((t) =>
          WRITE_CAPABLE_TOOLS.some((w) => t === w || t.startsWith(`${w}(`))
        )) {
          return "workspace-write";
        }
        return "workspace-read";
    }
  }

  private parseOutput(stdout: string): LensOutput | null {
    try {
      // Codex --json outputs JSONL (one event per line)
      const lines = stdout.trim().split("\n").filter(Boolean);
      if (lines.length === 0) return null;

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
    // Handle codex exec final output format
    if (typeof event === "string") return event;
    return null;
  }
}
