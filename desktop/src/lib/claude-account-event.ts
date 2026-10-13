/** Advisory only: the account last attempted by Claude Code for this session. */
export const PIX_CLAUDE_CODE_ACCOUNT_CHANNEL = "claude-code-account";

export interface ClaudeAccountAttempt {
  readonly name: string;
  readonly observedAt: number;
}

export function parseClaudeAccountAttempt(value: unknown, now = Date.now()): ClaudeAccountAttempt | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (record.version !== 1 || typeof record.name !== "string"
    || record.name.length === 0 || record.name.length > 64 || /[\r\n]/u.test(record.name)
    || typeof record.observedAt !== "number" || !Number.isSafeInteger(record.observedAt)
    || record.observedAt <= 0 || record.observedAt > now + 10_000) return undefined;
  return { name: record.name, observedAt: record.observedAt };
}
