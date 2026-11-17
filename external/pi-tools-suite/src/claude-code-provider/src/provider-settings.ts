import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse as parseJsonc, type ParseError } from "jsonc-parser";

/** User-level `claudeCodeProvider` preferences. */
export interface ClaudeCodeProviderSettings {
  /** Show Claude's `allowed_warning` rate-limit notices; rejections are always shown. */
  showRateLimitWarnings?: boolean;
}

const MAX_CONFIG_BYTES = 1024 * 1024;

function defaultUserConfigPath(): string {
  return join(process.env.HOME?.trim() || homedir(), ".config", "pi", "pi-tools-suite.jsonc");
}

/**
 * Reads `claudeCodeProvider` from the user-owned file only; a workspace cannot
 * configure this provider. Absent file or section means defaults. Retired keys
 * (the former multi-profile/rotation settings) are ignored, not rejected, so an
 * old configuration never disables the provider.
 */
export function loadClaudeCodeProviderSettings(filePath = defaultUserConfigPath()): ClaudeCodeProviderSettings {
  let raw: string;
  try {
    if (statSync(filePath).size > MAX_CONFIG_BYTES) throw new Error("config exceeds 1 MiB");
    raw = readFileSync(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new Error(`Claude Code provider settings: cannot read user config: ${String(error)}`);
  }
  const errors: ParseError[] = [];
  const parsed: unknown = parseJsonc(raw, errors, { allowTrailingComma: true });
  if (errors.length !== 0 || !parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Claude Code provider settings: invalid user JSONC configuration");
  }
  return parseClaudeCodeProviderSettings((parsed as Record<string, unknown>).claudeCodeProvider);
}

export function parseClaudeCodeProviderSettings(raw: unknown): ClaudeCodeProviderSettings {
  if (raw === undefined) return {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("claudeCodeProvider must be an object");
  const value = (raw as Record<string, unknown>).showRateLimitWarnings;
  if (value === undefined) return {};
  if (typeof value !== "boolean") throw new Error("claudeCodeProvider.showRateLimitWarnings must be a boolean");
  return { showRateLimitWarnings: value };
}
