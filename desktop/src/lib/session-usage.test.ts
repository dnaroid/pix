import { describe, expect, it } from "vitest";
import {
  formatSessionUsageCost,
  formatSessionUsageTokens,
} from "./session-usage";

describe("session usage presentation", () => {
  it("formats compact billing values", () => {
    expect(formatSessionUsageCost(0.034)).toBe("$0.034");
    expect(formatSessionUsageCost(1.234)).toBe("$1.23");
    expect(formatSessionUsageTokens(67_200)).toBe("67.2K");
  });
});
