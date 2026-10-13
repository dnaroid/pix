import { claudeAccountRows } from "./claude-account-settings";
import { parseSettingsSource, removeSettingsValue, updateSettingsSource } from "./settings";

export interface ClaudeAccountSwitcherConfig {
  readonly accounts: readonly { name: string; configDir: string }[];
  readonly selectedAccount: string;
  readonly autoRotate: boolean;
}

/** User config is the only owner of manual preference, shared across Pix hosts. */
export function claudeAccountSwitcherConfig(source: string): ClaudeAccountSwitcherConfig {
  const parsed = parseSettingsSource(source);
  if (parsed.errors.length > 0) throw new Error("Tools Suite config contains invalid JSONC");
  const provider = parsed.value.claudeCodeProvider;
  if (!provider || typeof provider !== "object" || Array.isArray(provider)) {
    return { accounts: [], selectedAccount: "", autoRotate: false };
  }
  const config = provider as Record<string, unknown>;
  const accounts = claudeAccountRows(config.accounts)
    .filter((account) => account.name.trim() && account.configDir.trim())
    .map((account) => ({ name: account.name.trim(), configDir: account.configDir.trim() }));
  const selectedAccount = typeof config.selectedAccount === "string"
    && accounts.some((account) => account.name === config.selectedAccount)
    ? config.selectedAccount : "";
  return { accounts, selectedAccount, autoRotate: config.autoRotate === true };
}

/** A narrowly scoped JSONC edit keeps OAuth paths, comments and other settings. */
export function selectClaudeAccountInSource(source: string, name: string): string {
  const config = claudeAccountSwitcherConfig(source);
  if (name && !config.accounts.some((account) => account.name === name)) {
    throw new Error("Selected Claude account is not configured");
  }
  const path = ["claudeCodeProvider", "selectedAccount"];
  return name ? updateSettingsSource(source, path, name) : removeSettingsValue(source, path);
}
