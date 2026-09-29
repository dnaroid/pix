import { describe, expect, it } from "vitest";
import {
  formatSessionUsageCost,
  formatSessionUsageTokens,
  providerUsageUrl,
} from "./session-usage";

describe("session usage presentation", () => {
  it("links known subscription providers to usage pages without guessing unknown URLs", () => {
    expect(providerUsageUrl("pi-claude-code-provider")).toBe("https://claude.ai/code#settings/usage");
    expect(providerUsageUrl("openai-codex")).toBe("https://chatgpt.com/codex/cloud/settings/analytics#usage");
    expect(providerUsageUrl("zai")).toBe("https://z.ai/manage-apikey/coding-plan/personal/usage");
    expect(providerUsageUrl("unknown")).toBeUndefined();
  });
  it("formats compact billing values", () => {
    expect(formatSessionUsageCost(0.034)).toBe("$0.034");
    expect(formatSessionUsageCost(1.234)).toBe("$1.23");
    expect(formatSessionUsageCost(1.234)).toBe("$1.23");
    expect(formatSessionUsageTokens(67_200)).toBe("67.2K");
  });
});
