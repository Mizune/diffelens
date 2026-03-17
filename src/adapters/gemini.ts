import { spawn, execFile } from "child_process";
import { promisify } from "util";
import type {
  CLIAdapter,
  CLIRequest,
  CLIResponse,
  LensOutput,
  ToolPolicy,
} from "./types.js";
import { hasWriteCapableTools } from "./types.js";
import { stripCodeFences, extractJsonFromText } from "./parse-utils.js";

const execAsync = promisify(execFile);

export class GeminiAdapter implements CLIAdapter {
  readonly name = "gemini";

  async isAvailable(): Promise<boolean> {
    try {
      await execAsync("gemini", ["--version"]);
      return true;
    } catch {
      return false;
    }
  }

  async execute(request: CLIRequest): Promise<CLIResponse> {
    const args = this.buildArgs(request);
    const start = Date.now();

    if (request.baseUrl) {
      console.warn("[gemini] base_url is ignored — Gemini CLI does not support API base URL via env vars");
    }

    return new Promise((resolve) => {
      const child = spawn("gemini", args, {
        cwd: request.cwd,
        env: {
          ...process.env,
          GEMINI_SYSTEM_MD: request.systemPromptPath,
        },
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

      // Send prompt via stdin (-p "" makes gemini read from stdin)
      child.stdin.write(request.userPrompt);
      child.stdin.end();
    });
  }

  private buildArgs(request: CLIRequest): string[] {
    const args: string[] = [
      "-p",
      "",
      "-o",
      "json",
      "-m",
      request.model,
      ...this.mapToolPolicy(request.toolPolicy),
    ];

    return args;
  }

  // Gemini CLI 0.33+ supports --approval-mode with fine-grained control:
  //   plan       — read-only mode (no file modifications)
  //   auto_edit  — auto-approve edit tools only
  //   yolo       — auto-approve all tools
  private mapToolPolicy(policy: ToolPolicy): string[] {
    switch (policy.type) {
      case "none": // falls through
      case "read_only":
        return ["--approval-mode", "plan"];
      case "all":
        return ["--approval-mode", "yolo"];
      case "explicit":
        return hasWriteCapableTools(policy.tools)
          ? ["--approval-mode", "auto_edit"]
          : ["--approval-mode", "plan"];
    }
  }

  private parseOutput(stdout: string): LensOutput | null {
    try {
      // gemini -o json -> { session_id, response, stats }
      const envelope = JSON.parse(stdout);

      if (envelope.error) {
        return null;
      }

      const content = envelope.response;
      if (typeof content !== "string") {
        return null;
      }

      try {
        return JSON.parse(stripCodeFences(content));
      } catch {
        return extractJsonFromText(content);
      }
    } catch {
      return extractJsonFromText(stdout);
    }
  }
}
