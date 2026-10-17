import { claudeAccountSwitcherConfig } from "./claude-account-switcher";
import { claudeConfigEnvironment } from "./claude-account-settings";

/** Only actionable Claude provider errors, never arbitrary transcript content. */
export function isClaudeLoginError(messageId: string | undefined, text: string): boolean {
  if (!messageId?.startsWith("pix-system:error:")
    && !messageId?.startsWith("pix-system:notification:error:")) return false;
  const claude = /Claude Code request failed(?: \(\d{3}\))?:|\[pi-claude-code-provider\]/i.test(text);
  return claude && /OAuth session expired|OAuth token revoked|(?:not logged in|run `claude auth login`)|Failed to authenticate/i.test(text);
}

export function claudeLoginProfiles(source: string) {
  const config = claudeAccountSwitcherConfig(source);
  return {
    accounts: config.accounts,
    selected: config.selectedAccount || (config.autoRotate ? config.accounts[0]?.name ?? "" : ""),
  };
}

/** Fixed operation; no error text, account labels or credentials enter the shell. */
export function claudeLoginCommand(configDir?: string): string {
  if (configDir && /[\r\n\0]/.test(configDir)) throw new Error("Claude profile path contains invalid control characters.");
  const prefix = configDir ? `${claudeConfigEnvironment(configDir)} ` : "";
  return `${prefix}"\${PI_CLAUDE_CODE_PROVIDER_PATH:-claude}" auth login --claudeai`;
}
