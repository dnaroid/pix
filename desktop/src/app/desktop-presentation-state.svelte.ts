import type { SessionInfo } from "@agentclientprotocol/sdk";
import {
  DESKTOP_SLASH_COMMANDS,
  mergeSlashCommands,
} from "../lib/slash-commands";
import { EMPTY_SESSION_ACTIVITY } from "../lib/session-activity";
import { buildTabSessions } from "../lib/session-tabs";
import {
  workbenchSessionTabId,
  type WorkbenchTabId,
} from "../lib/workbench-tabs";
import type { ActiveSessionState } from "./active-session-state.svelte";
import type { DesktopInteractionServices } from "./desktop-interaction-services.svelte";
import type { DesktopProjectServices } from "./desktop-project-services";
import type { DesktopPromptServices } from "./desktop-prompt-services";
import type { DesktopSessionServices } from "./desktop-session-services";
import { DRAFT_SESSION_TAB_ID, type createDraftSession } from "./draft-session.svelte";
import type { SessionTabAttentionStore } from "./session-tab-attention.svelte";
import {
  buildDesktopWorkbenchTabs,
  buildSessionWorkbenchTabs,
} from "./workbench-model";

type DraftSession = ReturnType<typeof createDraftSession>;

type DesktopPresentationStateOptions = {
  workspace: () => string;
  statusReady: () => boolean;
  operationRunning: () => boolean;
  activeWorkbenchTabId: () => WorkbenchTabId | null;
  state: ActiveSessionState;
  sessions: DesktopSessionServices;
  prompt: DesktopPromptServices;
  project: DesktopProjectServices;
  interactions: DesktopInteractionServices;
  draft: DraftSession;
  tabAttention: SessionTabAttentionStore;
};

export function createDesktopPresentationState(options: DesktopPresentationStateOptions) {
  const sessionMutationRunning = $derived(options.operationRunning() || options.draft.materializing);
  const canUseSession = $derived(options.statusReady() && !!options.workspace() && !sessionMutationRunning);
  const promptRunning = $derived(
    options.state.sessionId
      ? options.prompt.runtime.runningSessionIds.has(options.state.sessionId)
      : false,
  );
  const activeAgentControlState = $derived(
    options.state.sessionId
      ? (options.prompt.runtime.agentControlStates.get(options.state.sessionId) ?? "idle")
      : "idle",
  );
  const anyPromptRunning = $derived(options.prompt.runtime.runningSessionIds.size > 0);
  const pausedSessionIds = $derived.by(() => new Set(
    [...options.prompt.runtime.agentControlStates]
      .filter(([, state]) => state === "paused")
      .map(([sessionId]) => sessionId),
  ));
  const activeTitle = $derived(
    options.sessions.catalog.sessions.find((session) => session.sessionId === options.state.sessionId)?.title
      ?? "New conversation",
  );
  const tabSessions = $derived(buildTabSessions(
    options.sessions.catalog.sessions,
    options.sessions.tabs.restoredIds,
    options.sessions.tabs.locallyOpenedIds,
    options.sessions.tabs.closedIds,
    options.state.sessionId,
  ));
  const draftSessionInfo = $derived<SessionInfo>({
    sessionId: DRAFT_SESSION_TAB_ID,
    cwd: options.workspace(),
    title: "New conversation",
    updatedAt: null,
  });
  const titlebarSessions = $derived(
    options.draft.open ? [...tabSessions, draftSessionInfo] : tabSessions,
  );
  const activeConversationTabId = $derived(
    options.draft.active ? DRAFT_SESSION_TAB_ID : options.state.sessionId,
  );
  const activeConversationWorkbenchTabId = $derived(
    activeConversationTabId ? workbenchSessionTabId(activeConversationTabId) : null,
  );
  const sessionStartOpen = $derived(options.draft.active && !options.draft.touched);
  const sessionStartCandidates = $derived.by<SessionInfo[]>(() => {
    const openIds = new Set(tabSessions.map((session) => session.sessionId));
    return options.sessions.catalog.sessions.filter((session) => !openIds.has(session.sessionId));
  });
  const attachmentDraftKey = $derived(
    `${options.workspace()}\0${options.draft.active ? DRAFT_SESSION_TAB_ID : options.state.sessionId ?? ""}`,
  );
  const workbenchSessionTabs = $derived.by(() => buildSessionWorkbenchTabs({
    sessions: titlebarSessions,
    draftSessionTabId: DRAFT_SESSION_TAB_ID,
    pausedSessionIds,
    runningSessionIds: options.prompt.runtime.runningSessionIds,
    sessionActivityBySessionId: options.sessions.activity.summaries,
    pendingElicitationSessionIds: options.interactions.pendingElicitationSessionIds,
    unseenCompletedSessionIds: options.tabAttention.unseenCompletedSessionIds,
    disabled: sessionMutationRunning,
    selectionDisabled: options.operationRunning(),
    realSessionCount: tabSessions.length,
  }));
  const workbenchTabs = $derived.by(() => buildDesktopWorkbenchTabs({
    sessionTabs: workbenchSessionTabs,
    preview: options.project.preview.active,
    previewDirty: options.project.preview.dirty,
    previewAnchorId: options.project.preview.workbenchAnchorId,
    previewOpenedOrder: options.project.preview.workbenchOpenedOrder,
    gitDiff: options.project.git.diffPreview,
    gitReviewLoading: options.project.git.llmActionId?.startsWith("review:") === true,
    gitResolveRunning: options.project.git.resolveRunning,
    gitAnchorId: options.project.git.workbenchAnchorId,
    gitOpenedOrder: options.project.git.workbenchOpenedOrder,
  }));
  const activeWorkbenchTab = $derived(
    workbenchTabs.find((tab) => tab.id === options.activeWorkbenchTabId()),
  );
  const activeTodoSnapshot = $derived(
    options.state.sessionId ? options.sessions.activity.todos.get(options.state.sessionId) : undefined,
  );
  const activeSubagentSnapshot = $derived(
    options.state.sessionId ? options.sessions.activity.subagents.get(options.state.sessionId) : undefined,
  );
  const activeSessionActivity = $derived(
    options.state.sessionId
      ? (options.sessions.activity.summaries.get(options.state.sessionId) ?? EMPTY_SESSION_ACTIVITY)
      : EMPTY_SESSION_ACTIVITY,
  );
  const activeSlashCommands = $derived(
    mergeSlashCommands(
      DESKTOP_SLASH_COMMANDS,
      options.state.sessionId
        ? (options.sessions.metadata.slashCommandsBySession.get(options.state.sessionId) ?? [])
        : [],
    ),
  );
  const dcpCompressionAvailable = $derived(
    activeSlashCommands.some((command) => command.name.toLowerCase() === "dcp"),
  );

  return {
    get sessionMutationRunning() { return sessionMutationRunning; },
    get canUseSession() { return canUseSession; },
    get promptRunning() { return promptRunning; },
    get activeAgentControlState() { return activeAgentControlState; },
    get anyPromptRunning() { return anyPromptRunning; },
    get activeTitle() { return activeTitle; },
    get tabSessions() { return tabSessions; },
    get titlebarSessions() { return titlebarSessions; },
    get activeConversationTabId() { return activeConversationTabId; },
    get activeConversationWorkbenchTabId() { return activeConversationWorkbenchTabId; },
    get sessionStartOpen() { return sessionStartOpen; },
    get sessionStartCandidates() { return sessionStartCandidates; },
    get attachmentDraftKey() { return attachmentDraftKey; },
    get activePendingElicitation() { return options.interactions.activePendingElicitation; },
    get pendingElicitationSessionIds() { return options.interactions.pendingElicitationSessionIds; },
    get questionImageOperationIds() { return options.interactions.questionImageOperationIds; },
    get workbenchSessionTabs() { return workbenchSessionTabs; },
    get workbenchTabs() { return workbenchTabs; },
    get activeWorkbenchTab() { return activeWorkbenchTab; },
    get activeTodoSnapshot() { return activeTodoSnapshot; },
    get activeSubagentSnapshot() { return activeSubagentSnapshot; },
    get activeSessionActivity() { return activeSessionActivity; },
    get activeSlashCommands() { return activeSlashCommands; },
    get dcpCompressionAvailable() { return dcpCompressionAvailable; },
  };
}

export type DesktopPresentationState = ReturnType<typeof createDesktopPresentationState>;
