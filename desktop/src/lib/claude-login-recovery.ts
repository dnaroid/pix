/** Only actionable Claude provider errors, never arbitrary transcript content. */
export function isClaudeLoginError(messageId: string | undefined, text: string): boolean {
  if (!messageId?.startsWith("pix-system:error:")
    && !messageId?.startsWith("pix-system:notification:error:")) return false;
  const claude = /Claude Code request failed(?: \(\d{3}\))?:|\[pi-claude-code-provider\]/i.test(text);
  return claude && /OAuth session expired|OAuth token revoked|(?:not logged in|run `claude auth login`)|Failed to authenticate/i.test(text);
}

/** Fixed operation; no error text, account labels or credentials enter the shell. */
export function claudeLoginCommand(): string {
  return `"\${PI_CLAUDE_CODE_PROVIDER_PATH:-claude}" auth login --claudeai`;
}
