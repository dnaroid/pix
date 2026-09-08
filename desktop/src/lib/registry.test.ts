import { describe, expect, it } from "vitest";
import {
  REGISTRY_STATE_CHANNEL,
  registryActionLabel,
  registryHasAttention,
  registryPrimaryAction,
  registrySnapshotFromSessionState,
} from "./registry";

describe("registry session state", () => {
  it("parses a structured resource snapshot", () => {
    const snapshot = registrySnapshotFromSessionState({
      sessionId: "session-1",
      channel: REGISTRY_STATE_CHANNEL,
      data: {
        version: 1,
        configured: true,
        remote: "git@example.com:me/registry.git",
        branch: "main",
        projectKey: "project-alpha",
        checkedAt: "2026-09-08T12:00:00.000Z",
        items: [
          {
            id: "skill:demo",
            type: "skill",
            name: "demo",
            status: "update-available",
            statusLabel: "OUTDATED",
            icon: "↓",
            description: "Demo skill",
            local: true,
            remote: true,
            actions: ["update", "uninstall", "remove"],
          },
          {
            id: "project:todo",
            type: "project",
            name: "TODO.md",
            artifact: "todo",
            status: "local-changes",
            statusLabel: "LOCAL CHANGES",
            icon: "↑",
            local: true,
            remote: true,
            actions: ["push"],
          },
        ],
      },
    });

    expect(snapshot?.remote).toBe("git@example.com:me/registry.git");
    expect(snapshot?.items).toHaveLength(2);
    expect(snapshot?.items[0]?.actions).toEqual(["update", "uninstall", "remove"]);
    expect(registryHasAttention(snapshot)).toBe(true);
    expect(registryPrimaryAction(snapshot!.items[0]!)).toBe("update");
    expect(registryPrimaryAction(snapshot!.items[1]!)).toBe("push");
  });

  it("ignores other channels and malformed snapshots", () => {
    expect(registrySnapshotFromSessionState({ sessionId: "s", channel: "other", data: {} })).toBeUndefined();
    expect(registrySnapshotFromSessionState({
      sessionId: "s",
      channel: REGISTRY_STATE_CHANNEL,
      data: { version: 1, configured: true, branch: "main", checkedAt: "now", items: [{ nope: true }] },
    })).toBeUndefined();
  });

  it("keeps destructive-only current resources out of primary actions", () => {
    const snapshot = registrySnapshotFromSessionState({
      sessionId: "s",
      channel: REGISTRY_STATE_CHANNEL,
      data: {
        version: 1,
        configured: true,
        branch: "main",
        checkedAt: "now",
        items: [{
          id: "agent:reviewer",
          type: "agent",
          name: "reviewer",
          status: "up-to-date",
          statusLabel: "UP TO DATE",
          icon: "✓",
          local: true,
          remote: true,
          actions: ["uninstall", "remove"],
        }],
      },
    });

    expect(registryHasAttention(snapshot)).toBe(false);
    expect(registryPrimaryAction(snapshot!.items[0]!)).toBeUndefined();
    expect(registryActionLabel("remove")).toBe("Remove from registry");
  });
});
