import { describe, expect, it } from "vitest";
import { registryProjectSyncPresentation } from "./registry-project-sync";
import type { RegistryItem, RegistryStatus } from "./registry";
import type { RegistryBackgroundSyncState } from "./registry-background-sync";

const idle: RegistryBackgroundSyncState = { phase: "idle", dirtyScopes: [] };
function item(status: RegistryStatus): RegistryItem {
  return { id: "project:workspace", type: "project", artifact: "workspace", name: "workspace.jsonc",
    status, statusLabel: status, icon: "", local: true, remote: true, actions: ["push", "pull"] };
}

describe("project sync presentation", () => {
  it.each(["local-only", "local-changes"] as const)("does not require manual review for %s", (status) => {
    expect(registryProjectSyncPresentation([item(status)], idle, undefined, false)).toMatchObject({
      title: "Syncing project…", needsReview: false,
    });
  });
  it.each(["diverged", "registry-changed", "untracked-local", "not-installed"] as const)("preserves review for %s", (status) => {
    expect(registryProjectSyncPresentation([item(status)], idle, undefined, false)).toMatchObject({
      title: "Review project sync", needsReview: true,
    });
  });
  it("surfaces returned and coordinator errors even with otherwise clean items", () => {
    expect(registryProjectSyncPresentation([], idle, "Access denied", false).description).toBe("Access denied");
    expect(registryProjectSyncPresentation([], { ...idle, phase: "error", error: "Remote changed" }, undefined, false))
      .toMatchObject({ needsReview: true, description: "Remote changed" });
  });
  it("shows pending and in-flight writes rather than falsely declaring clean", () => {
    for (const phase of ["pending", "syncing"] as const) {
      expect(registryProjectSyncPresentation([], { ...idle, phase }, undefined, false).title).toBe("Syncing project…");
    }
    expect(registryProjectSyncPresentation([], idle, undefined, false).title).toBe("Project synced");
    expect(registryProjectSyncPresentation([], idle, undefined, true).title).toBe("Project sync needs a key");
  });
});
