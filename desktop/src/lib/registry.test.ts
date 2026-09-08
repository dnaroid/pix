import { describe, expect, it } from "vitest";
import {
  REGISTRY_STATE_CHANNEL,
  compareRegistryItems,
  registryActionLabel,
  registryFriendlyActionLabel,
  registryFriendlyStatusDescription,
  registryFriendlyStatusLabel,
  registryHasAttention,
  registryPrimaryAction,
  searchRegistryItems,
  registrySnapshotFromSessionState,
  type RegistryItem,
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

  it("sorts installed reusable resources before remote-only resources", () => {
    const items: RegistryItem[] = [
      {
        id: "skill:remote",
        type: "skill" as const,
        name: "remote",
        status: "not-installed" as const,
        statusLabel: "NOT INSTALLED",
        icon: "·",
        local: false,
        remote: true,
        actions: ["install" as const],
      },
      {
        id: "agent:local",
        type: "agent" as const,
        name: "local",
        status: "up-to-date" as const,
        statusLabel: "UP TO DATE",
        icon: "✓",
        local: true,
        remote: true,
        actions: ["uninstall" as const],
      },
      {
        id: "skill:changed",
        type: "skill" as const,
        name: "changed",
        status: "local-changes" as const,
        statusLabel: "LOCAL CHANGES",
        icon: "↑",
        local: true,
        remote: true,
        actions: ["push" as const],
      },
    ];

    expect(items.slice().sort(compareRegistryItems).map((item) => item.id)).toEqual([
      "skill:changed",
      "agent:local",
      "skill:remote",
    ]);
  });

  it("uses user-facing sync labels", () => {
    const localOnly = {
      id: "skill:draft",
      type: "skill" as const,
      name: "draft",
      status: "local-only" as const,
      statusLabel: "LOCAL ONLY",
      icon: "+",
      local: true,
      remote: false,
      actions: ["push" as const],
    };
    const untracked = { ...localOnly, status: "untracked-local" as const, remote: true, actions: ["push" as const, "pull" as const] };
    expect(registryFriendlyStatusLabel(localOnly)).toBe("Local only");
    expect(registryFriendlyStatusDescription(localOnly)).toContain("Only in this project");
    expect(registryFriendlyActionLabel(localOnly, "push")).toBe("Add to registry");
    expect(registryFriendlyStatusLabel(untracked)).toBe("Needs review");
    expect(registryFriendlyActionLabel(untracked, "push")).toBe("Keep local version");
    expect(registryFriendlyActionLabel(untracked, "pull")).toBe("Keep registry version");
  });

  it("fuzzy search narrows project resources by name", () => {
    const items = [
      {
        id: "project:todo",
        type: "project" as const,
        name: "TODO.md",
        artifact: "todo" as const,
        status: "local-only" as const,
        statusLabel: "LOCAL ONLY",
        icon: "+",
        local: true,
        remote: false,
        actions: ["push" as const],
      },
      {
        id: "project:plans",
        type: "project" as const,
        name: "plans/",
        artifact: "plans" as const,
        status: "local-only" as const,
        statusLabel: "LOCAL ONLY",
        icon: "+",
        local: true,
        remote: false,
        actions: ["push" as const],
      },
      {
        id: "project:tasks",
        type: "project" as const,
        name: "tasks.jsonc",
        artifact: "tasks" as const,
        status: "up-to-date" as const,
        statusLabel: "UP TO DATE",
        icon: "✓",
        local: true,
        remote: true,
        actions: [],
      },
    ];

    expect(searchRegistryItems(items, "todo").map((item) => item.id)).toEqual(["project:todo"]);
    expect(searchRegistryItems(items, "plan").map((item) => item.id)).toEqual(["project:plans"]);
    expect(searchRegistryItems(items, "task").map((item) => item.id)).toEqual(["project:tasks"]);
  });
});
