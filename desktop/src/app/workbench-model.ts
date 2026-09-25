import type { SessionInfo } from "@agentclientprotocol/sdk";
import {
  sessionActivityLabel,
  type SessionActivitySummary,
} from "../lib/session-activity";
import { sessionTabStatusKind, sessionTabStatusLabel } from "../lib/session-tab-status";
import {
  buildWorkbenchTabs,
  workbenchSessionTabId,
  type WorkbenchAuxiliaryPlacement,
  type WorkbenchDiffTab,
  type WorkbenchLspInstallTab,
  type WorkbenchPreviewTab,
  type WorkbenchSessionTab,
  type WorkbenchTab,
  type WorkbenchTabId,
  type WorkbenchTerminalTab,
} from "../lib/workbench-tabs";
import { sessionIsFork } from "../lib/session-tabs";

export function workbenchTabLabel(value: string): string {
  const normalized = value.replaceAll("\\", "/").replace(/\/$/u, "");
  return normalized.split("/").at(-1) || value;
}

export function sessionWorkbenchTitle(session: SessionInfo): string {
  const title = session.title || "Untitled conversation";
  if (!session.updatedAt) return title;
  const date = new Date(session.updatedAt);
  if (Number.isNaN(date.valueOf())) return title;
  return `${title} · ${date.toLocaleString([], { dateStyle: "short", timeStyle: "short" })}`;
}

export function buildSessionWorkbenchTabs(options: {
  sessions: readonly SessionInfo[];
  draftSessionTabId: string;
  pausedSessionIds: ReadonlySet<string>;
  runningSessionIds: ReadonlySet<string>;
  sessionActivityBySessionId: ReadonlyMap<string, SessionActivitySummary>;
  pendingElicitationSessionIds: ReadonlySet<string>;
  unseenCompletedSessionIds: ReadonlySet<string>;
  disabled: boolean;
  selectionDisabled?: boolean;
  realSessionCount: number;
}): WorkbenchSessionTab[] {
  return options.sessions.map((session) => {
    const paused = options.pausedSessionIds.has(session.sessionId);
    const running = options.runningSessionIds.has(session.sessionId);
    const activity = options.sessionActivityBySessionId.get(session.sessionId);
    const needsInput = options.pendingElicitationSessionIds.has(session.sessionId);
    const draft = session.sessionId === options.draftSessionTabId;
    const activityLabel = sessionActivityLabel(activity, running, needsInput);
    const statusKind = sessionTabStatusKind({
      activity,
      paused,
      running,
      needsInput,
      unseenComplete: options.unseenCompletedSessionIds.has(session.sessionId),
    });
    const statusLabel = sessionTabStatusLabel(statusKind, activityLabel);
    return {
      id: workbenchSessionTabId(session.sessionId),
      kind: "session",
      sessionId: session.sessionId,
      label: session.title || "Untitled conversation",
      title: `${sessionWorkbenchTitle(session)} · ${statusLabel}`,
      panelId: "conversation-workspace",
      closable: !draft || options.realSessionCount > 0,
      disabled: options.disabled,
      selectionDisabled: options.selectionDisabled,
      running,
      draft,
      fork: sessionIsFork(session),
      statusKind,
    };
  });
}

type PreviewLike =
  | { kind: "file"; file: { path: string } }
  | { kind: "attachment"; attachment: { name: string } };

type GitDiffLike = {
  path?: string | null;
  scope: string;
};

export function buildDesktopWorkbenchTabs(options: {
  sessionTabs: readonly WorkbenchSessionTab[];
  preview?: PreviewLike;
  previewDirty: boolean;
  previewAnchorId: WorkbenchTabId | null;
  previewOpenedOrder: number;
  gitDiff?: GitDiffLike | null;
  gitReviewLoading: boolean;
  gitResolveRunning: boolean;
  gitAnchorId: WorkbenchTabId | null;
  gitOpenedOrder: number;
  lspInstall?: {
    languageLabel: string;
    serverLabel: string;
    phase: string;
    insertAfterId: WorkbenchTabId | null;
    openedOrder: number;
  } | null;
  terminal?: {
    insertAfterId: WorkbenchTabId | null;
    openedOrder: number;
  } | null;
}): WorkbenchTab[] {
  const auxiliary: WorkbenchAuxiliaryPlacement[] = [];
  if (options.preview) {
    const previewTitle = options.preview.kind === "file"
      ? options.preview.file.path
      : options.preview.attachment.name;
    const previewTab: WorkbenchPreviewTab = {
      id: "preview",
      label: workbenchTabLabel(previewTitle),
      title: previewTitle,
      panelId: "workbench-panel-preview",
      kind: "preview",
      closable: true,
      dirty: options.previewDirty,
    };
    auxiliary.push({
      tab: previewTab,
      insertAfterId: options.previewAnchorId,
      openedOrder: options.previewOpenedOrder || 1,
    });
  }
  if (options.gitDiff) {
    const target = options.gitDiff.path ?? "All changes";
    const diffTab: WorkbenchDiffTab = {
      id: "git-diff",
      label: options.gitDiff.path ? `${workbenchTabLabel(target)} · Diff` : "All Changes · Diff",
      title: `${target} · ${options.gitDiff.scope}`,
      panelId: "workbench-panel-git-diff",
      kind: "diff",
      closable: true,
      busy: options.gitReviewLoading || options.gitResolveRunning,
    };
    auxiliary.push({
      tab: diffTab,
      insertAfterId: options.gitAnchorId,
      openedOrder: options.gitOpenedOrder || 2,
    });
  }
  if (options.lspInstall) {
    const lspTab: WorkbenchLspInstallTab = {
      id: "lsp-install",
      label: `${options.lspInstall.languageLabel} · LSP`,
      title: `${options.lspInstall.serverLabel} · LSP installation`,
      panelId: "workbench-panel-lsp-install",
      kind: "lsp-install",
      closable: options.lspInstall.phase === "success" || options.lspInstall.phase === "error",
      busy: options.lspInstall.phase === "installing",
    };
    auxiliary.push({
      tab: lspTab,
      insertAfterId: options.lspInstall.insertAfterId,
      openedOrder: options.lspInstall.openedOrder || 3,
    });
  }
  if (options.terminal) {
    const terminalTab: WorkbenchTerminalTab = {
      id: "terminal",
      label: "Terminal",
      title: "Interactive terminal",
      panelId: "workbench-panel-terminal",
      kind: "terminal",
      closable: true,
    };
    auxiliary.push({
      tab: terminalTab,
      insertAfterId: options.terminal.insertAfterId,
      openedOrder: options.terminal.openedOrder || 4,
    });
  }
  return buildWorkbenchTabs([...options.sessionTabs], auxiliary);
}
