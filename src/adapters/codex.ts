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
import { MAX_BUFFER_BYTES, hasWriteCapableTools } from "./types.js";
import { stripCodeFences } from "./parse-utils.js";

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
        env: {
          ...process.env,
          ...(request.baseUrl ? { OPENAI_BASE_URL: request.baseUrl } : {}),
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
      "--skip-git-repo-check",
      "--sandbox",
      this.mapToolPolicy(request.toolPolicy),
      "-",  // read prompt from stdin
    ];

    return { args, fullPrompt };
  }

  private mapToolPolicy(policy: ToolPolicy): string {
    switch (policy.type) {
      case "none": // falls through
      case "read_only":
        return "read-only";
      case "all":
        return "danger-full-access";
      case "explicit":
        return hasWriteCapableTools(policy.tools)
          ? "workspace-write"
          : "read-only";
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
            return JSON.parse(stripCodeFences(content));
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
    // Codex v0.115.0+: {"type":"item.completed","item":{"type":"agent_message","text":"..."}}
    if (
      event?.type === "item.completed" &&
      event?.item?.type === "agent_message" &&
      typeof event.item.text === "string"
    ) {
      return event.item.text;
    }
    // Legacy: {"type":"message","role":"assistant","content":"..."}
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
