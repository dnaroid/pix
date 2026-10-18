import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { completeDesktopOnboarding, desktopOnboardingCompleted } from "./desktop-onboarding";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

describe("global Desktop onboarding", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it.each([true, false])("reads global completion: %s", async (completed) => {
    vi.mocked(invoke).mockResolvedValue(completed);
    expect(await desktopOnboardingCompleted()).toBe(completed);
    expect(invoke).toHaveBeenCalledExactlyOnceWith("desktop_onboarding_status", { complete: false });
  });

  it("persists completion globally", async () => {
    vi.mocked(invoke).mockResolvedValue(true);
    await completeDesktopOnboarding();
    expect(invoke).toHaveBeenCalledExactlyOnceWith("desktop_onboarding_status", { complete: true });
  });

  it("propagates native storage failures", async () => {
    vi.mocked(invoke).mockRejectedValue(new Error("storage failed"));
    await expect(desktopOnboardingCompleted()).rejects.toThrow("storage failed");
    await expect(completeDesktopOnboarding()).rejects.toThrow("storage failed");
  });
});
