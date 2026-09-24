import { describe, expect, it } from "vitest";
import { shouldShowStatusBarSkeletons } from "./status-bar-skeleton";

const base = {
  connectionStatus: "ready" as const,
  draft: false,
  historyLoading: false,
  sessionId: "session-1",
  runtimeReady: true,
  runtimeStatusAvailable: true,
};

describe("status bar skeleton visibility", () => {
  it("covers application startup", () => {
    expect(shouldShowStatusBarSkeletons({
      ...base,
      connectionStatus: "starting",
      sessionId: null,
      runtimeReady: false,
      runtimeStatusAvailable: false,
    })).toBe(true);
  });

  it("keeps placeholders on the draft tab while rendering any values that are already known", () => {
    expect(shouldShowStatusBarSkeletons({
      ...base,
      draft: true,
      sessionId: null,
      runtimeReady: false,
      runtimeStatusAvailable: false,
    })).toBe(true);
  });

  it("covers tab switches until history, runtime, and the first runtime snapshot are ready", () => {
    expect(shouldShowStatusBarSkeletons({ ...base, historyLoading: true })).toBe(true);
    expect(shouldShowStatusBarSkeletons({ ...base, runtimeReady: false })).toBe(true);
    expect(shouldShowStatusBarSkeletons({ ...base, runtimeStatusAvailable: false })).toBe(true);
    expect(shouldShowStatusBarSkeletons(base)).toBe(false);
  });

  it("does not mask connection failures with loading placeholders", () => {
    expect(shouldShowStatusBarSkeletons({
      ...base,
      connectionStatus: "error",
      draft: true,
      historyLoading: true,
    })).toBe(false);
    expect(shouldShowStatusBarSkeletons({
      ...base,
      connectionStatus: "stopped",
      runtimeReady: false,
      runtimeStatusAvailable: false,
    })).toBe(false);
  });
});
