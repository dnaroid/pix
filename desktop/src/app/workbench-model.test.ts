import type { SessionInfo } from "@agentclientprotocol/sdk";
import { describe, expect, it } from "vitest";
import { buildDesktopWorkbenchTabs, buildSessionWorkbenchTabs } from "./workbench-model";
import { workbenchSessionTabId } from "../lib/workbench-tabs";
import { EMPTY_SESSION_ACTIVITY } from "../lib/session-activity";
import { agentControlShowsPausedTab, type AgentControlState } from "../lib/agent-control";
import type { SessionSubagentSnapshot } from "../lib/session-subagents";

function build(sessions: SessionInfo[], subagentsBySessionId?: ReadonlyMap<string, SessionSubagentSnapshot>) {
  return buildSessionWorkbenchTabs({
    sessions,
    draftSessionTabId: "draft",
    pausedSessionIds: new Set(),
    runningSessionIds: new Set(),
    sessionActivityBySessionId: new Map(),
    subagentsBySessionId,
    pendingElicitationSessionIds: new Set(),
    unseenCompletedSessionIds: new Set(),
    disabled: false,
    realSessionCount: sessions.length,
  });
}

describe("session workbench model", () => {
  it("marks viewers with their own profile icon matched by parent, run and agent, with a bot fallback", () => {
    const viewer = (id: string, runDir: string, agentId: string): SessionInfo => ({
      sessionId: id, cwd: "/tmp", _meta: {
        "pix.subagent": { runDir, agentId, parentSessionId: "parent" },
      },
    });
    const tabs = build([
      viewer("child", "/right", "worker"),
      viewer("missing-run", "/missing", "worker"),
      viewer("missing-agent", "/right", "missing"),
      { sessionId: "regular", cwd: "/tmp" },
    ], new Map([["parent", { version: 1, checkedAt: 1, count: 0, runs: [
      { runDir: "/wrong", agents: [], tasks: [{ id: "worker", icon: "bug" }] },
      { runDir: "/right", agents: [], tasks: [{ id: "worker", icon: "eye" }] },
    ] }]]));
    expect(tabs.map((tab) => tab.subagentIcon)).toEqual(["eye", "agent", "agent", undefined]);
    expect(tabs[0]?.statusKind).toBe("idle");
    expect(build([viewer("restored", "/right", "worker")])[0]?.subagentIcon).toBe("agent");
  });

  it("uses authoritative session file metadata, never an ID or draft path", () => {
    const tabs = build([
      { sessionId: "saved", cwd: "/tmp", _meta: { "pix.sessionFile": "/sessions/мой session.jsonl" } },
      { sessionId: "missing", cwd: "/tmp" },
      { sessionId: "invalid", cwd: "/tmp", _meta: { "pix.sessionFile": 42 } },
      { sessionId: "draft", cwd: "/tmp", _meta: { "pix.sessionFile": "/sessions/old.jsonl" } },
    ]);
    expect(tabs.map((tab) => tab.sessionFile)).toEqual(["/sessions/мой session.jsonl", undefined, undefined, undefined]);
  });

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
    expect(tab?.title).toContain("Steps 0/1");
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

  it("labels virtual contents and uses the real directory for reverse navigation", () => {
    const tabs = buildDesktopWorkbenchTabs({
      sessionTabs: [], preview: { kind: "file", file: {
        path: "wiki/rules/index.md", virtualWikiDirectory: "wiki/rules",
      } }, previewDirty: false, previewAnchorId: null, previewOpenedOrder: 1,
      gitReviewLoading: false, gitResolveRunning: false, gitAnchorId: null, gitOpenedOrder: 0,
    });
    expect(tabs[0]).toMatchObject({
      kind: "preview", label: "rules · Contents", title: "wiki/rules/ · Contents", filePath: "wiki/rules",
    });
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

  it("places one Wiki Conflicts tab beside its opener with a bounded open count", () => {
    const [session] = build([{ sessionId: "session-1", cwd: "/tmp/project", title: "Session" }]);
    const base = {
      sessionTabs: session ? [session] : [],
      previewDirty: false, previewAnchorId: null, previewOpenedOrder: 0,
      gitDiff: null, gitReviewLoading: false, gitResolveRunning: false, gitAnchorId: null, gitOpenedOrder: 0,
      lspInstall: null,
      terminal: { insertAfterId: workbenchSessionTabId("session-1"), openedOrder: 1 },
    };
    const tabs = buildDesktopWorkbenchTabs({
      ...base,
      wikiConflicts: { openCount: 7.9, insertAfterId: workbenchSessionTabId("session-1"), openedOrder: 2 },
    });
    expect(tabs.map((tab) => tab.id)).toEqual([workbenchSessionTabId("session-1"), "wiki-conflicts", "terminal"]);
    expect(tabs[1]).toMatchObject({
      kind: "wiki-conflicts", label: "Wiki Conflicts", title: "Wiki Conflicts · 7 open",
      panelId: "workbench-panel-wiki-conflicts", closable: true, openCount: 7,
    });
    const empty = buildDesktopWorkbenchTabs({ ...base, wikiConflicts: { openCount: -2, insertAfterId: null, openedOrder: 0 } });
    expect(empty.at(-1)).toMatchObject({ id: "wiki-conflicts", title: "Wiki Conflicts", openCount: 0 });
    expect(buildDesktopWorkbenchTabs(base).some((tab) => tab.id === "wiki-conflicts")).toBe(false);
  });
});

