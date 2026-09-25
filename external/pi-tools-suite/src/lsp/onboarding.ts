import path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadLspConfig } from "./_shared/config.js";
import type { LspServerConfig } from "./_shared/types.js";
import { couldMatchBeforeRoot } from "./lsp-utils.js";
import { publishRpcSessionState } from "../lib/rpc-session-state.js";

export const LSP_ONBOARDING_CHANNEL = "pi-tools-suite:lsp-missing";

export interface LspOnboardingDefinition {
  readonly installerId: string;
  readonly languageId: string;
  readonly languageLabel: string;
  readonly serverLabel: string;
  readonly extensions: readonly string[];
  readonly server: LspServerConfig;
}

export interface LspMissingNotification {
  readonly version: 1;
  readonly installerId: string;
  readonly languageId: string;
  readonly languageLabel: string;
  readonly serverLabel: string;
  readonly path: string;
  readonly checkedAt: number;
}

export const LSP_ONBOARDING_DEFINITIONS: readonly LspOnboardingDefinition[] = [
  {
    installerId: "typescript",
    languageId: "typescript",
    languageLabel: "TypeScript / JavaScript",
    serverLabel: "TypeScript Language Server",
    extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"],
    server: {
      id: "typescript",
      include: ["**/*.ts", "**/*.tsx", "**/*.js", "**/*.jsx", "**/*.mjs", "**/*.cjs"],
      exclude: ["**/node_modules/**", "**/.next/**"],
      rootMarkers: ["tsconfig.json", "package.json", ".git"],
      bin: "typescript-language-server",
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
  },
  {
    installerId: "svelte",
    languageId: "svelte",
    languageLabel: "Svelte",
    serverLabel: "Svelte Language Server",
    extensions: [".svelte"],
    server: {
      id: "svelte",
      include: ["**/*.svelte"],
      exclude: ["**/node_modules/**"],
      rootMarkers: ["svelte.config.js", "svelte.config.ts", "package.json", ".git"],
      bin: "svelteserver",
      args: ["--stdio"],
      startupTimeoutMs: 30_000,
      diagnosticsWaitMs: 8_000,
      languageIdByExtension: { ".svelte": "svelte" },
    },
  },
  {
    installerId: "vue",
    languageId: "vue",
    languageLabel: "Vue",
    serverLabel: "Vue Language Server",
    extensions: [".vue"],
    server: {
      id: "vue",
      include: ["**/*.vue"],
      exclude: ["**/node_modules/**"],
      rootMarkers: ["vite.config.ts", "vite.config.js", "package.json", ".git"],
      bin: "vue-language-server",
      args: ["--stdio"],
      languageIdByExtension: { ".vue": "vue" },
    },
  },
  {
    installerId: "python",
    languageId: "python",
    languageLabel: "Python",
    serverLabel: "Python LSP Server",
    extensions: [".py", ".pyi"],
    server: {
      id: "python",
      include: ["**/*.py", "**/*.pyi"],
      exclude: ["**/.git/**", "**/__pycache__/**", "**/.venv/**", "**/venv/**", "**/.tox/**"],
      rootMarkers: ["pyproject.toml", "setup.py", "setup.cfg", "requirements.txt", "Pipfile", "poetry.lock", ".git"],
      bin: "pylsp",
      args: [],
      languageIdByExtension: { ".py": "python", ".pyi": "python" },
    },
  },
  {
    installerId: "go",
    languageId: "go",
    languageLabel: "Go",
    serverLabel: "gopls",
    extensions: [".go"],
    server: {
      id: "go",
      include: ["**/*.go"],
      exclude: ["**/.git/**", "**/vendor/**"],
      rootMarkers: ["go.work", "go.mod", ".git"],
      bin: "gopls",
      args: [],
      languageIdByExtension: { ".go": "go" },
    },
  },
  {
    installerId: "rust",
    languageId: "rust",
    languageLabel: "Rust",
    serverLabel: "rust-analyzer",
    extensions: [".rs"],
    server: {
      id: "rust",
      include: ["**/*.rs"],
      exclude: ["**/.git/**", "**/target/**"],
      rootMarkers: ["Cargo.toml", "rust-project.json", ".git"],
      bin: "rust-analyzer",
      args: [],
      startupTimeoutMs: 20_000,
      diagnosticsWaitMs: 20_000,
      pullDiagnostics: false,
      waitForPublishDiagnostics: true,
      languageIdByExtension: { ".rs": "rust" },
    },
  },
  {
    installerId: "ruby",
    languageId: "ruby",
    languageLabel: "Ruby",
    serverLabel: "Ruby LSP",
    extensions: [".rb", ".rake", ".gemspec"],
    server: {
      id: "ruby",
      include: ["**/*.rb", "**/*.rake", "**/*.gemspec", "**/Gemfile", "**/Rakefile"],
      exclude: ["**/.git/**", "**/vendor/bundle/**", "**/.bundle/**", "**/tmp/**", "**/log/**"],
      rootMarkers: ["Gemfile.lock", "*.gemspec", "Rakefile", ".ruby-version", ".git"],
      bin: "ruby-lsp",
      args: [],
      startupTimeoutMs: 60_000,
      diagnosticsWaitMs: 10_000,
      languageIdByExtension: { ".rb": "ruby", ".rake": "ruby", ".gemspec": "ruby" },
    },
  },
];

export function lspOnboardingDefinitionForFile(file: string): LspOnboardingDefinition | undefined {
  const extension = path.extname(file).toLowerCase();
  return LSP_ONBOARDING_DEFINITIONS.find((definition) => definition.extensions.includes(extension));
}

export async function lspOnboardingProposalForFile(
  ctx: ExtensionContext,
  file: string,
): Promise<LspMissingNotification | undefined> {
  const definition = lspOnboardingDefinitionForFile(file);
  if (!definition) return undefined;
  const loaded = await loadLspConfig(ctx);
  const registered = loaded.items.some((server: LspServerConfig) => (
    server.enabled !== false
    && couldMatchBeforeRoot(file, ctx.cwd, server.include, server.exclude)
  ));
  if (registered) return undefined;
  return {
    version: 1,
    installerId: definition.installerId,
    languageId: definition.languageId,
    languageLabel: definition.languageLabel,
    serverLabel: definition.serverLabel,
    path: file,
    checkedAt: Date.now(),
  };
}

export async function publishMissingLspSuggestion(ctx: ExtensionContext, file: string): Promise<void> {
  const proposal = await lspOnboardingProposalForFile(ctx, file);
  if (!proposal) return;
  publishRpcSessionState(ctx, LSP_ONBOARDING_CHANNEL, proposal);
}
