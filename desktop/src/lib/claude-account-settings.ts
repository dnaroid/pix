export interface ClaudeAccountSetting {
  name: string;
  configDir: string;
}

export function claudeAccountRows(value: unknown): ClaudeAccountSetting[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => {
    const record = item && typeof item === "object" && !Array.isArray(item) ? item as Record<string, unknown> : {};
    return {
      name: typeof record.name === "string" ? record.name : "",
      configDir: typeof record.configDir === "string" ? record.configDir : "",
    };
  });
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function claudeAuthCommand(configDir: string, action: "login" | "status"): string {
  const trimmed = configDir.trim();
  const path = trimmed.startsWith("~/")
    ? `"$HOME/${trimmed.slice(2).replace(/[\\"$`]/g, "\\$&")}"`
    : shellQuote(trimmed);
  return `CLAUDE_CONFIG_DIR=${path} claude auth ${action}`;
}
