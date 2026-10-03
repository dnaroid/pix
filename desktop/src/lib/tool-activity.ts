import { toolPresentationName } from "./tool-presentation";

export type InferredToolAction = "Running tests" | "Building project" | "Checking project"
  | "Starting agents" | "Waiting for agents" | "Checking agents" | "Stopping agents";

const DIRECTORY_OPTIONS: Readonly<Record<string, readonly string[]>> = {
  npm: ["--prefix"], pnpm: ["--dir", "-C"], yarn: ["--cwd"], bun: ["--cwd"],
};

/** Ingestion-only classifier. Never return payload text or attempt to interpret shell programs. */
export function inferToolAction(tool: { name?: string; title: string; kind: string; rawInput?: unknown }): InferredToolAction | undefined {
  const input = tool.rawInput;
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  const args = input as Record<string, unknown>;
  const name = toolPresentationName(tool);
  if (name === "subagents") {
    switch (args.action) {
      case "spawn": return "Starting agents";
      case "wait": return "Waiting for agents";
      case "status": return "Checking agents";
      case "stop": return "Stopping agents";
      default: return undefined;
    }
  }
  if (!["bash", "shell", "shell_command", "exec", "execute", "run_command"].includes(name)) return undefined;
  return commandAction(args.command);
}

function commandAction(command: unknown): InferredToolAction | undefined {
  if (typeof command !== "string" || command.length > 4096
    || /[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069$`|&;<>()[\]{}'"\\]/u.test(command)) return undefined;
  const tokens = command.trim().split(/ +/u);
  if (tokens.some((token) => ["--help", "-h", "--version", "-v", "--dry-run", "--list", "--listTests", "--showConfig"].includes(token))) return undefined;
  const executable = tokens.shift();
  if (["npm", "pnpm", "yarn", "bun"].includes(executable ?? "")) {
    // Only known directory selectors may precede the script; unknown options are ambiguous.
    const directoryOptions = DIRECTORY_OPTIONS[executable ?? ""] ?? [];
    if (directoryOptions.includes(tokens[0] ?? "")) {
      tokens.shift();
      if (!tokens.shift() || tokens[0]?.startsWith("-")) return undefined;
    }
    if (tokens[0] === "run") tokens.shift();
    return scriptAction(tokens[0]);
  }
  if (executable === "cargo" || executable === "go") {
    if (tokens[0] === "test") return "Running tests";
    if (tokens[0] === "build") return "Building project";
    if ((tokens[0] === "check" && executable === "cargo") || (tokens[0] === "vet" && executable === "go")) return "Checking project";
    return undefined;
  }
  const runner = executable === "npx" ? tokens.shift() : executable;
  if (["vitest", "jest", "pytest"].includes(runner ?? "")) return "Running tests";
  if (runner === "playwright" && tokens[0] === "test") return "Running tests";
  if (["tsc", "svelte-check", "eslint"].includes(runner ?? "")) return "Checking project";
  if (runner === "ruff" && tokens[0] === "check") return "Checking project";
  if (runner === "vite" && tokens[0] === "build") return "Building project";
  return undefined;
}

function scriptAction(script: string | undefined): InferredToolAction | undefined {
  if (/^test(?::[\w-]+)*$/u.test(script ?? "")) return "Running tests";
  if (/^build(?::[\w-]+)*$/u.test(script ?? "")) return "Building project";
  if (/^(check|typecheck|lint)(?::[\w-]+)*$/u.test(script ?? "")) return "Checking project";
  return undefined;
}
