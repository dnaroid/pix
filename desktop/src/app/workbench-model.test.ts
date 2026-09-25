import type { SessionInfo } from "@agentclientprotocol/sdk";
import { describe, expect, it } from "vitest";
import { buildDesktopWorkbenchTabs, buildSessionWorkbenchTabs } from "./workbench-model";
import { workbenchSessionTabId } from "../lib/workbench-tabs";

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
