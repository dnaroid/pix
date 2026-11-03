import { describe, expect, it } from "vitest";
import { registryProjectCleanupAllowed } from "./registry-project-cleanup";

const idle = { busy: false, actionId: null, loading: false, error: null, cleanupAvailable: false };

describe("Registry project cleanup availability", () => {
  it.each(["Storage meter timed out", "Storage meter unavailable"])("allows cleanup after %s without an estimate", (error) => {
    expect(registryProjectCleanupAllowed({ ...idle, error })).toBe(true);
  });

  it.each([
    { busy: true },
    { actionId: "cleanup-project" },
    { actionId: "initialize-project" },
    { actionId: "pull-project" },
  ])("preserves action exclusivity after a meter failure: %j", (lock) => {
    expect(registryProjectCleanupAllowed({ ...idle, error: "Storage meter timed out", ...lock })).toBe(false);
  });

  it("disables cleanup while inspecting and when a successful estimate found no garbage", () => {
    expect(registryProjectCleanupAllowed({ ...idle, loading: true })).toBe(false);
    expect(registryProjectCleanupAllowed({ ...idle, loading: true, cleanupAvailable: true })).toBe(false);
    expect(registryProjectCleanupAllowed(idle)).toBe(false);
    expect(registryProjectCleanupAllowed({ ...idle, cleanupAvailable: true })).toBe(true);
  });
});
