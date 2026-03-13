import type { CLIAdapter } from "./types.js";
import { ClaudeCodeAdapter } from "./claude-code.js";
import { CodexAdapter } from "./codex.js";

export type CLIName = "claude" | "codex";

const adapterFactories: Record<CLIName, () => CLIAdapter> = {
  claude: () => new ClaudeCodeAdapter(),
  codex: () => new CodexAdapter(),
};

/** Get adapter. Checks availability before returning. */
export async function getAdapter(name: CLIName): Promise<CLIAdapter> {
  const factory = adapterFactories[name];
  if (!factory) {
    throw new Error(
      `Unknown CLI "${name}". Available: ${Object.keys(adapterFactories).join(", ")}`
    );
  }

  const adapter = factory();
  const available = await adapter.isAvailable();
  if (!available) {
    throw new Error(
      `CLI "${name}" is not installed or not in PATH. ` +
        `Install: ${getInstallHint(name)}`
    );
  }

  return adapter;
}

function getInstallHint(name: CLIName): string {
  switch (name) {
    case "claude":
      return "npm install -g @anthropic-ai/claude-code";
    case "codex":
      return "npm install -g @openai/codex";
  }
}

/** Check availability of all adapters */
export async function checkAvailability(): Promise<Record<CLIName, boolean>> {
  const results: Record<string, boolean> = {};
  for (const [name, factory] of Object.entries(adapterFactories)) {
    const adapter = factory();
    results[name] = await adapter.isAvailable();
  }
  return results as Record<CLIName, boolean>;
}

export type {
  CLIAdapter,
  CLIRequest,
  CLIResponse,
  ToolPolicy,
  LensOutput,
  Finding,
} from "./types.js";
