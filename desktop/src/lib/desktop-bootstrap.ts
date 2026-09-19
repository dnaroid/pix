import { invoke } from "@tauri-apps/api/core";

export interface DesktopBootstrapSnapshot {
  readonly format: number;
  readonly runtime: {
    readonly ready: boolean;
    readonly bundled: boolean;
    readonly pi: string;
    readonly suite: string;
  };
  readonly pi: {
    readonly agentDir: string;
    readonly authPath: string;
    readonly providers: readonly string[];
  };
  readonly opencode: {
    readonly authPath: string;
    readonly authDetected: boolean;
    readonly providers: readonly string[];
    readonly antigravityDetected: boolean;
    readonly antigravityPath: string;
  };
  readonly codex: {
    readonly authPath: string;
    readonly apiKeyDetected: boolean;
    readonly oauthDetected: boolean;
    readonly authMode?: string;
  };
  readonly idx: {
    readonly available: boolean;
    readonly installed: boolean;
    readonly version?: string;
    readonly entryPath?: string;
    readonly toolsRoot: string;
    readonly systemExecutable?: string;
  };
}

export interface OpenCodeImportResult {
  readonly sourcePath: string;
  readonly authPath: string;
  readonly wroteAuth: boolean;
  readonly providers: readonly {
    readonly label: string;
    readonly sourceProvider: string;
    readonly targetProvider: string;
    readonly status: string;
  }[];
  readonly antigravity?: {
    readonly imported: boolean;
    readonly reason?: string;
    readonly email?: string;
  };
}

export interface CodexApiKeyImportResult {
  readonly status: "imported" | "already-imported" | "auth-exists" | "source-missing";
  readonly sourcePath: string;
  readonly targetProvider: "openai";
}

export interface IdxInstallResult {
  readonly status: "installed" | "already-installed";
  readonly installed: boolean;
  readonly version?: string;
  readonly entryPath?: string;
  readonly toolsRoot: string;
}

export function inspectDesktopBootstrap(): Promise<DesktopBootstrapSnapshot> {
  return invoke("desktop_bootstrap_inspect");
}

export function importOpenCodeCredentials(): Promise<OpenCodeImportResult> {
  return invoke("desktop_bootstrap_import_opencode");
}

export function importCodexApiKey(): Promise<CodexApiKeyImportResult> {
  return invoke("desktop_bootstrap_import_codex_api_key");
}

export function installManagedIdx(): Promise<IdxInstallResult> {
  return invoke("desktop_bootstrap_install_idx");
}

export function importedOpenCodeProviders(result: OpenCodeImportResult): readonly string[] {
  return result.providers
    .filter((provider) => provider.status === "imported")
    .map((provider) => provider.targetProvider);
}
