import { applyEdits, modify, parse, type ParseError } from "jsonc-parser";
import type { SessionStateNotification } from "./session-state";

export const LSP_ONBOARDING_CHANNEL = "pi-tools-suite:lsp-missing";

export const LSP_INSTALLER_IDS = [
  "typescript",
  "svelte",
  "vue",
  "python",
  "go",
  "rust",
  "ruby",
] as const;

export type LspInstallerId = (typeof LSP_INSTALLER_IDS)[number];

export interface LspMissingSuggestion {
  readonly sessionId: string;
  readonly installerId: LspInstallerId;
  readonly languageId: string;
  readonly languageLabel: string;
  readonly serverLabel: string;
  readonly path: string;
  readonly checkedAt: number;
}

export interface LspInstallResult {
  readonly installerId: LspInstallerId;
  readonly bin: string;
  readonly env: Readonly<Record<string, string>>;
  readonly output: string;
}

type LspServerConfig = {
  id: string;
  include: string[];
  exclude?: string[];
  rootMarkers: string[];
  bin: string;
  args: string[];
  env?: Record<string, string>;
  startupTimeoutMs?: number;
  diagnosticsWaitMs?: number;
  pullDiagnostics?: boolean;
  waitForPublishDiagnostics?: boolean;
  languageIdByExtension: Record<string, string>;
};

const SERVER_TEMPLATES: Record<LspInstallerId, Omit<LspServerConfig, "bin" | "env">> = {
  typescript: {
    id: "typescript",
    include: ["**/*.ts", "**/*.tsx", "**/*.js", "**/*.jsx", "**/*.mjs", "**/*.cjs"],
    exclude: ["**/node_modules/**", "**/.next/**"],
    rootMarkers: ["tsconfig.json", "package.json", ".git"],
    args: ["--stdio"],
    languageIdByExtension: {
      ".ts": "typescript",
      ".tsx": "typescriptreact",
      ".js": "javascript",
      ".jsx": "javascriptreact",
      ".mjs": "javascript",
      ".cjs": "javascript",
    },
  },
  svelte: {
    id: "svelte",
    include: ["**/*.svelte"],
    exclude: ["**/node_modules/**"],
    rootMarkers: ["svelte.config.js", "svelte.config.ts", "package.json", ".git"],
    args: ["--stdio"],
    startupTimeoutMs: 30_000,
    diagnosticsWaitMs: 8_000,
    languageIdByExtension: { ".svelte": "svelte" },
  },
  vue: {
    id: "vue",
    include: ["**/*.vue"],
    exclude: ["**/node_modules/**"],
    rootMarkers: ["vite.config.ts", "vite.config.js", "package.json", ".git"],
    args: ["--stdio"],
    languageIdByExtension: { ".vue": "vue" },
  },
  python: {
    id: "python",
    include: ["**/*.py", "**/*.pyi"],
    exclude: ["**/.git/**", "**/__pycache__/**", "**/.venv/**", "**/venv/**", "**/.tox/**"],
    rootMarkers: ["pyproject.toml", "setup.py", "setup.cfg", "requirements.txt", "Pipfile", "poetry.lock", ".git"],
    args: [],
    languageIdByExtension: { ".py": "python", ".pyi": "python" },
  },
  go: {
    id: "go",
    include: ["**/*.go"],
    exclude: ["**/.git/**", "**/vendor/**"],
    rootMarkers: ["go.work", "go.mod", ".git"],
    args: [],
    languageIdByExtension: { ".go": "go" },
  },
  rust: {
    id: "rust",
    include: ["**/*.rs"],
    exclude: ["**/.git/**", "**/target/**"],
    rootMarkers: ["Cargo.toml", "rust-project.json", ".git"],
    args: [],
    startupTimeoutMs: 20_000,
    diagnosticsWaitMs: 20_000,
    pullDiagnostics: false,
    waitForPublishDiagnostics: true,
    languageIdByExtension: { ".rs": "rust" },
  },
  ruby: {
    id: "ruby",
    include: ["**/*.rb", "**/*.rake", "**/*.gemspec", "**/Gemfile", "**/Rakefile"],
    exclude: ["**/.git/**", "**/vendor/bundle/**", "**/.bundle/**", "**/tmp/**", "**/log/**"],
    rootMarkers: ["Gemfile.lock", "*.gemspec", "Rakefile", ".ruby-version", ".git"],
    args: [],
    startupTimeoutMs: 60_000,
    diagnosticsWaitMs: 10_000,
    languageIdByExtension: { ".rb": "ruby", ".rake": "ruby", ".gemspec": "ruby" },
  },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isInstallerId(value: unknown): value is LspInstallerId {
  return typeof value === "string" && (LSP_INSTALLER_IDS as readonly string[]).includes(value);
}

export function lspMissingSuggestionFromSessionState(
  notification: SessionStateNotification,
): LspMissingSuggestion | undefined {
  if (notification.channel !== LSP_ONBOARDING_CHANNEL || !isRecord(notification.data)) return undefined;
  const data = notification.data;
  if (
    data.version !== 1
    || !isInstallerId(data.installerId)
    || typeof data.languageId !== "string"
    || typeof data.languageLabel !== "string"
    || typeof data.serverLabel !== "string"
    || typeof data.path !== "string"
    || typeof data.checkedAt !== "number"
    || !Number.isFinite(data.checkedAt)
  ) return undefined;
  return {
    sessionId: notification.sessionId,
    installerId: data.installerId,
    languageId: data.languageId,
    languageLabel: data.languageLabel,
    serverLabel: data.serverLabel,
    path: data.path,
    checkedAt: data.checkedAt,
  };
}

export function lspServerConfigForInstall(result: LspInstallResult): LspServerConfig {
  const template = SERVER_TEMPLATES[result.installerId];
  const env = Object.fromEntries(
    Object.entries(result.env).filter(([key, value]) => key.trim() && value.trim()),
  );
  return {
    ...template,
    bin: result.bin,
    ...(Object.keys(env).length > 0 ? { env } : {}),
  };
}

export function piToolsSuiteConfigWithLspServer(source: string, server: LspServerConfig): string {
  const base = source.trim() ? source : "{}\n";
  const errors: ParseError[] = [];
  const parsed = parse(base, errors, { allowTrailingComma: true, disallowComments: false }) as unknown;
  if (errors.length > 0 || !isRecord(parsed)) {
    throw new Error("pi-tools-suite.jsonc is malformed; fix it before installing an LSP.");
  }
  const lsp = parsed.lsp;
  if (lsp !== undefined && !isRecord(lsp)) {
    throw new Error("pi-tools-suite.jsonc has an invalid lsp section.");
  }
  const currentServers = isRecord(lsp) ? lsp.servers : undefined;
  if (currentServers !== undefined && !Array.isArray(currentServers)) {
    throw new Error("pi-tools-suite.jsonc has an invalid lsp.servers section.");
  }
  const formattingOptions = { insertSpaces: true, tabSize: 2, eol: "\n" };
  let edits;
  if (!Array.isArray(currentServers)) {
    edits = modify(base, ["lsp", "servers"], [server], { formattingOptions });
  } else {
    const existingIndex = currentServers.findIndex((item) => isRecord(item) && item.id === server.id);
    if (existingIndex >= 0) {
      edits = modify(base, ["lsp", "servers", existingIndex], server, { formattingOptions });
    } else {
      edits = modify(base, ["lsp", "servers", currentServers.length], server, {
        formattingOptions,
        isArrayInsertion: true,
      });
    }
  }
  const next = applyEdits(base, edits);
  return next.endsWith("\n") ? next : next + "\n";
}
