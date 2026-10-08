import type { SessionInfo } from "@agentclientprotocol/sdk";
import { describe, expect, it } from "vitest";
import { buildDesktopWorkbenchTabs, buildSessionWorkbenchTabs } from "./workbench-model";
import { workbenchSessionTabId } from "../lib/workbench-tabs";
import { EMPTY_SESSION_ACTIVITY } from "../lib/session-activity";
import { agentControlShowsPausedTab, type AgentControlState } from "../lib/agent-control";

function build(sessions: SessionInfo[]) {
  return buildSessionWorkbenchTabs({
    sessions,
    draftSessionTabId: "draft",
    pausedSessionIds: new Set(),
    runningSessionIds: new Set(),
    sessionActivityBySessionId: new Map(),
    pendingElicitationSessionIds: new Set(),
    unseenCompletedSessionIds: new Set(),
    disabled: false,
    realSessionCount: sessions.length,
  });
}

describe("session workbench model", () => {
  it("keeps selection enabled independently from guarded close/mutation controls", () => {
    const tabs = buildSessionWorkbenchTabs({
      sessions: [{ sessionId: "a", cwd: "/tmp" }, { sessionId: "draft", cwd: "/tmp" }],
      draftSessionTabId: "draft",
      pausedSessionIds: new Set(),
      runningSessionIds: new Set(),
      sessionActivityBySessionId: new Map(),
      pendingElicitationSessionIds: new Set(),
      unseenCompletedSessionIds: new Set(),
      disabled: true,
      selectionDisabled: false,
      realSessionCount: 1,
    });
    expect(tabs.map((tab) => [tab.disabled, tab.selectionDisabled])).toEqual([[true, false], [true, false]]);
  });

  it("marks only ACP sessions carrying Pix fork metadata as forks", () => {
    const [forked, regular] = build([
      { sessionId: "forked", cwd: "/tmp/project", _meta: { "pix.isFork": true } },
      { sessionId: "regular", cwd: "/tmp/project" },
    ]);

    expect(forked?.fork).toBe(true);
    expect(regular?.fork).toBe(false);
  });

  it("marks a paused session as paused even while its prompt runtime is still settling", () => {
    const [tab] = buildSessionWorkbenchTabs({
      sessions: [{ sessionId: "paused", cwd: "/tmp/project", title: "Paused tab" }],
      draftSessionTabId: "draft",
      pausedSessionIds: new Set(["paused"]),
      runningSessionIds: new Set(["paused"]),
      sessionActivityBySessionId: new Map(),
      pendingElicitationSessionIds: new Set(),
      unseenCompletedSessionIds: new Set(),
      disabled: false,
      realSessionCount: 1,
    });

    expect(tab?.statusKind).toBe("paused");
    expect(tab?.title).toContain("Paused");
  });

  it("changes the restored tab icon when loading discovers continuation, and clears it on resume", () => {
    function tabFor(state: AgentControlState) {
      return buildSessionWorkbenchTabs({
        sessions: [{ sessionId: "restored", cwd: "/tmp/project" }],
        draftSessionTabId: "draft",
        pausedSessionIds: new Set(agentControlShowsPausedTab(state) ? ["restored"] : []),
        runningSessionIds: new Set(state === "resuming" ? ["restored"] : []),
        sessionActivityBySessionId: new Map(),
        pendingElicitationSessionIds: new Set(),
        unseenCompletedSessionIds: new Set(),
        disabled: false,
        realSessionCount: 1,
      })[0];
    }

    expect(tabFor("idle")?.statusKind).toBe("idle");
    expect(tabFor("continuable")?.statusKind).toBe("paused");
    expect(tabFor("continuable")?.title).toContain("Paused");
    expect(tabFor("resuming")?.statusKind).toBe("running");
    expect(tabFor("idle")?.statusKind).toBe("idle");
  });

  it("does not spin an idle session tab solely because its saved plan has in-progress work", () => {
    const [tab] = buildSessionWorkbenchTabs({
      sessions: [{ sessionId: "idle", cwd: "/tmp/project", title: "Idle tab" }],
      draftSessionTabId: "draft",
      pausedSessionIds: new Set(),
      runningSessionIds: new Set(),
      sessionActivityBySessionId: new Map([["idle", {
        ...EMPTY_SESSION_ACTIVITY,
        inProgressTodos: 1,
        openTodos: 1,
        totalTodos: 1,
      }]]),
      pendingElicitationSessionIds: new Set(),
      unseenCompletedSessionIds: new Set(),
      disabled: false,
      realSessionCount: 1,
    });

    expect(tab?.statusKind).toBe("idle");
    expect(tab?.title).toContain("Plan 0/1");
  });

  it("carries the actual preview path, not the display name, into tab context metadata", () => {
    for (const preview of [
      { kind: "file" as const, file: { path: "src/main.ts" } },
      { kind: "attachment" as const, attachment: { name: "clip.mov", path: "/tmp/my clip.mov" } },
    ]) {
      const tabs = buildDesktopWorkbenchTabs({
        sessionTabs: [], preview, previewDirty: false, previewAnchorId: null, previewOpenedOrder: 1,
        gitReviewLoading: false, gitResolveRunning: false, gitAnchorId: null, gitOpenedOrder: 0,
      });
      expect(tabs[0]).toMatchObject({ kind: "preview", filePath: preview.kind === "file" ? "src/main.ts" : "/tmp/my clip.mov" });
    }
  });

  it("inserts a dedicated LSP installer beside the owning conversation and locks close while busy", () => {
    const [session] = build([{ sessionId: "session-1", cwd: "/tmp/project", title: "Session" }]);
    const tabs = buildDesktopWorkbenchTabs({
      sessionTabs: session ? [session] : [],
      previewDirty: false,
      previewAnchorId: null,
      previewOpenedOrder: 0,
      gitDiff: null,
      gitReviewLoading: false,
      gitResolveRunning: false,
      gitAnchorId: null,
      gitOpenedOrder: 0,
      lspInstall: {
        languageLabel: "Rust",
        serverLabel: "rust-analyzer",
        phase: "installing",
        insertAfterId: workbenchSessionTabId("session-1"),
        openedOrder: 1,
      },
    });

    expect(tabs.map((tab) => tab.id)).toEqual([workbenchSessionTabId("session-1"), "lsp-install"]);
    expect(tabs[1]).toMatchObject({
      kind: "lsp-install",
      label: "Rust · LSP",
      closable: false,
      busy: true,
    });
  });

  it("labels a historical Git Diff tab by its selected commit instead of All Changes", () => {
    const hash = "0123456789abcdef0123456789abcdef01234567";
    const tabs = buildDesktopWorkbenchTabs({
      sessionTabs: [],
      previewDirty: false,
      previewAnchorId: null,
      previewOpenedOrder: 0,
      gitDiff: { scope: "all", commit: { hash, shortHash: "01234567", subject: "Repair merge" } },
      gitReviewLoading: false,
      gitResolveRunning: false,
      gitAnchorId: null,
      gitOpenedOrder: 3,
    });
    expect(tabs[0]).toMatchObject({
      kind: "diff",
      id: "git-diff",
      label: "Commit 01234567",
      title: `${hash} · Repair merge`,
      closable: true,
    });
  });

  it("inserts a closable Terminal tab beside the workbench surface that opened it", () => {
    const [session] = build([{ sessionId: "session-1", cwd: "/tmp/project", title: "Session" }]);
    const tabs = buildDesktopWorkbenchTabs({
      sessionTabs: session ? [session] : [],
      previewDirty: false,
      previewAnchorId: null,
      previewOpenedOrder: 0,
      gitDiff: null,
      gitReviewLoading: false,
      gitResolveRunning: false,
      gitAnchorId: null,
      gitOpenedOrder: 0,
      lspInstall: null,
      terminal: {
        insertAfterId: workbenchSessionTabId("session-1"),
        openedOrder: 1,
      },
    });

    expect(tabs.map((tab) => tab.id)).toEqual([workbenchSessionTabId("session-1"), "terminal"]);
    expect(tabs[1]).toMatchObject({
      kind: "terminal",
      label: "Terminal",
      panelId: "workbench-panel-terminal",
      closable: true,
    });
  });
});
