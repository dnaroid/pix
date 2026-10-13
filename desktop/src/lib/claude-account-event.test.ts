import { describe, expect, it } from "vitest";
import { parseClaudeAccountAttempt } from "./claude-account-event";

describe("Claude Code account attempt notifications", () => {
  it("accepts only versioned, recent, non-sensitive labels", () => {
    const now = 1_800_000_000_000;
    expect(parseClaudeAccountAttempt({ version: 1, name: "Personal", observedAt: now }, now))
      .toEqual({ name: "Personal", observedAt: now });
    for (const data of [
      { version: 2, name: "Work", observedAt: now },
      { version: 1, name: "", observedAt: now },
      { version: 1, name: "Line\nBreak", observedAt: now },
      { version: 1, name: "Work", observedAt: now + 20_000 },
      { version: 1, name: "Work", observedAt: "yesterday" },
    ]) {
      expect(parseClaudeAccountAttempt(data, now)).toBeUndefined();
    }
  });
});
