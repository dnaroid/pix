import type { SessionInfo } from "@agentclientprotocol/sdk";
import {
  sessionActivityLabel,
  sessionActivityTone,
  type SessionActivitySummary,
} from "../lib/session-activity";
import {
  buildWorkbenchTabs,
  workbenchSessionTabId,
  type WorkbenchAuxiliaryPlacement,
  type WorkbenchDiffTab,
  type WorkbenchPreviewTab,
  type WorkbenchSessionTab,
  type WorkbenchTab,
  type WorkbenchTabId,
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
  activeConversationTabId: string | null;
  runningSessionIds: ReadonlySet<string>;
  sessionActivityBySessionId: ReadonlyMap<string, SessionActivitySummary>;
  pendingElicitationSessionIds: ReadonlySet<string>;
  disabled: boolean;
  realSessionCount: number;
}): WorkbenchSessionTab[] {
  return options.sessions.map((session) => {
    const running = options.runningSessionIds.has(session.sessionId);
    const activity = options.sessionActivityBySessionId.get(session.sessionId);
    const needsInput = options.pendingElicitationSessionIds.has(session.sessionId);
    const draft = session.sessionId === options.draftSessionTabId;
    const activityLabel = sessionActivityLabel(activity, running, needsInput);
    return {
      id: workbenchSessionTabId(session.sessionId),
      kind: "session",
      sessionId: session.sessionId,
      label: session.title || "Untitled conversation",
      title: `${sessionWorkbenchTitle(session)} · ${activityLabel}`,
      panelId: "conversation-workspace",
      closable: !draft || options.realSessionCount > 0,
      disabled: options.disabled,
      runtimeActive: session.sessionId === options.activeConversationTabId,
      running,
      draft,
      fork: sessionIsFork(session),
      activityTone: sessionActivityTone(activity, running, needsInput),
      activityLabel,
      pulsing: running || (activity?.activeSubagents ?? 0) > 0,
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
  return buildWorkbenchTabs([...options.sessionTabs], auxiliary);
}
