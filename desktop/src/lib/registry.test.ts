import { describe, expect, it } from "vitest";
import {
  REGISTRY_STATE_CHANNEL,
  compareRegistryItems,
  parseRegistryDiff,
  registryActionLabel,
  registryCatalogItems,
  registryCatalogSection,
  registryDiffAvailable,
  registryFriendlyActionLabel,
  registryFriendlyStatusDescription,
  registryFriendlyStatusLabel,
  registryHasAttention,
  registryPrimaryAction,
  searchRegistryItems,
  registrySnapshotFromSessionState,
  type RegistryItem,
  type RegistryStatus,
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

  it("separates publication from installation and excludes project artifacts", () => {
    const installed: RegistryItem = {
      id: "skill:installed",
      type: "skill",
      name: "installed",
      status: "up-to-date",
      statusLabel: "UP TO DATE",
      icon: "✓",
      local: true,
      remote: true,
      actions: ["uninstall"],
    };
    const available: RegistryItem = {
      id: "agent:available",
      type: "agent",
      name: "available",
      status: "not-installed",
      statusLabel: "NOT INSTALLED",
      icon: "·",
      local: false,
      remote: true,
      actions: ["install"],
    };
    const project: RegistryItem = {
      id: "project:todo",
      type: "project",
      name: "TODO.md",
      artifact: "todo",
      status: "up-to-date",
      statusLabel: "UP TO DATE",
      icon: "✓",
      local: true,
      remote: true,
      actions: [],
    };
    const stale: RegistryItem = {
      id: "skill:stale",
      type: "skill",
      name: "stale",
      status: "removed-remote",
      statusLabel: "REMOVED REMOTE",
      icon: "!",
      local: false,
      remote: false,
      actions: [],
    };

    const localOnly = { ...installed, remote: false, status: "local-only" as const };
    expect(registryCatalogSection(localOnly)).toBe("local");
    expect(registryCatalogSection(installed)).toBe("global");
    expect(registryCatalogSection(available)).toBe("global");
    expect(registryCatalogSection(project)).toBeUndefined();
    expect(registryCatalogSection(stale)).toBeUndefined();
    expect(registryCatalogItems([available, localOnly, project, stale, installed], "local")).toEqual([localOnly]);
    expect(registryCatalogItems([available, localOnly, project, stale, installed], "global")).toEqual([available, installed]);
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
    expect(registryFriendlyActionLabel(localOnly, "push")).toBe("Make global (publish)");
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

  it("parses optional tags, searches them, and rejects malformed metadata", () => {
    const raw = { version: 1, configured: false, branch: "main", checkedAt: "now", items: [{
      id: "agent:reviewer", type: "agent", name: "reviewer", status: "local-only", statusLabel: "LOCAL ONLY",
      icon: "+", local: true, remote: false, tags: ["quality", "security"], actions: ["tags", "make-local"],
    }] };
    const event = { sessionId: "s", channel: REGISTRY_STATE_CHANNEL, data: raw };
    const snapshot = registrySnapshotFromSessionState(event)!;
    expect(snapshot.items[0]!.tags).toEqual(["quality", "security"]);
    expect(searchRegistryItems(snapshot.items, "security")).toHaveLength(1);
    expect(searchRegistryItems(snapshot.items, "unrelated")).toHaveLength(0);
    expect(registryPrimaryAction(snapshot.items[0]!)).toBeUndefined();
    expect(registrySnapshotFromSessionState({ ...event, data: { ...raw, items: [{ ...raw.items[0], tags: [7] }] } })).toBeUndefined();
  });
});

describe("registry resource diff", () => {
  function diffableItem(overrides: Partial<RegistryItem> = {}): RegistryItem {
    return {
      id: "agent:researcher",
      type: "agent",
      name: "researcher",
      status: "diverged",
      statusLabel: "DIVERGED",
      icon: "!",
      local: true,
      remote: true,
      actions: ["push", "pull"],
      ...overrides,
    };
  }

  it("parses a structured file diff with null sides and notices", () => {
    const diff = parseRegistryDiff({
      files: [
        { path: "agents/researcher.md", oldText: "old body\n", newText: "new body\n" },
        { path: "agents/researcher/notes.md", oldText: null, newText: "added sidecar\n" },
        { path: "agents/researcher/old.md", oldText: "gone\n", newText: null },
        { path: "agents/researcher/logo.png", oldText: null, newText: null, notice: "Binary file not shown" },
      ],
    });

    expect(diff?.files).toHaveLength(4);
    expect(diff?.files[0]).toEqual({ path: "agents/researcher.md", oldText: "old body\n", newText: "new body\n" });
    expect(diff?.files[1]?.oldText).toBeNull();
    expect(diff?.files[2]?.newText).toBeNull();
    expect(diff?.files[3]).toEqual({
      path: "agents/researcher/logo.png",
      oldText: null,
      newText: null,
      notice: "Binary file not shown",
    });
  });

  it("rejects malformed diff payloads", () => {
    expect(parseRegistryDiff(undefined)).toBeUndefined();
    expect(parseRegistryDiff({})).toBeUndefined();
    expect(parseRegistryDiff({ files: "nope" })).toBeUndefined();
    expect(parseRegistryDiff({ files: [{ path: "", oldText: null, newText: null }] })).toBeUndefined();
    expect(parseRegistryDiff({ files: [{ path: "a.md", oldText: 7, newText: null }] })).toBeUndefined();
    expect(parseRegistryDiff({ files: [{ path: "a.md", oldText: null, newText: null, notice: 3 }] })).toBeUndefined();
  });

  it("offers a two-sided diff only for changed resources with both copies", () => {
    const twoSided: RegistryStatus[] = ["local-changes", "update-available", "diverged", "untracked-local"];
    for (const status of twoSided) {
      expect(registryDiffAvailable(diffableItem({ status }))).toBe(true);
    }

    expect(registryDiffAvailable(diffableItem({ status: "up-to-date" }))).toBe(false);
    expect(registryDiffAvailable(diffableItem({ status: "local-only", remote: false }))).toBe(false);
    expect(registryDiffAvailable(diffableItem({ status: "not-installed", local: false }))).toBe(false);
    expect(registryDiffAvailable(diffableItem({ status: "missing-local", local: false }))).toBe(false);
    expect(registryDiffAvailable(diffableItem({ status: "removed-remote", remote: false }))).toBe(false);
    expect(registryDiffAvailable(diffableItem({ status: "registry-changed" }))).toBe(true);
    expect(registryDiffAvailable(diffableItem({ type: "skill", status: "local-changes" }))).toBe(true);
    expect(registryDiffAvailable({
      ...diffableItem(),
      type: "project",
      artifact: "todo",
      status: "local-changes",
    })).toBe(false);
  });
});
