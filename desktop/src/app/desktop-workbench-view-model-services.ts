import type { WikiFileDates } from "../lib/wiki-file-dates";
import { invoke } from "@tauri-apps/api/core";
import { externalEditorLabel } from "../lib/desktop-config";
import { createDiagnosticLogger } from "../lib/diagnostic-logging";
import type { ProjectFilePreview } from "../lib/project-files";
import type { DesktopViewModelServicesOptions } from "./desktop-view-model-service-options";
import { createDesktopWorkbenchViewModel } from "./desktop-workbench-view-model.svelte";
import type { SubagentSessionNavigation } from "./desktop-subagent-navigation";
import { toasts } from "./toasts.svelte";
import { wikiConflictsText, wikiVerdictLabel } from "../components/wiki-conflicts-text";

/** Undo window for a Wiki finding decision. */
const WIKI_DECISION_UNDO_MS = 8_000;

export function createDesktopWorkbenchViewModelServices(
  options: DesktopViewModelServicesOptions,
  subagentNavigation?: SubagentSessionNavigation,
) {
  return createDesktopWorkbenchViewModel({
    layout: {
      conversationVisible: () => options.presentation.activeWorkbenchTab?.kind === "session",
      conversationLabelledBy: () => options.presentation.activeConversationWorkbenchTabId
        ? `workbench-tab-${options.presentation.activeConversationWorkbenchTabId}`
        : undefined,
    },
    shell: {
      workspace: options.workspace,
      errorMessage: () => options.errors.message,
      statusError: () => options.status() === "error",
      reconnect: options.reconnect,
      errors: options.errors,
      sessionStartOpen: () => options.presentation.sessionStartOpen,
      sessionStartCandidates: () => options.presentation.sessionStartCandidates,
      searchClient: options.client,
      sessionTabs: options.transitions.sessionTabs,
    },
    conversation: {
      subagentLink: () => options.presentation.activeSubagentLink,
      subagentNavigation,
      transcript: () => options.state.transcript,
      activeSessionId: () => options.state.sessionId,
      workspace: options.workspace,
      promptRunning: () => options.presentation.promptRunning,
      operationRunning: options.operationRunning,
      sessionHistoryLoading: () => options.sessions.history.loading,
      promptText: options.promptText,
      setPromptText: (text) => options.setPromptText(text),
      promptAttachments: options.promptAttachments,
      statusReady: () => options.status() === "ready",
      activeSessionRuntimeReady: () => options.state.runtimeReady,
      sessionMutationRunning: () => options.presentation.sessionMutationRunning,
      dragActive: options.dragActive,
      activeAgentControlState: () => options.presentation.activeAgentControlState,
      activeSlashCommands: () => options.presentation.activeSlashCommands,
      pendingElicitation: () => options.presentation.activePendingElicitation,
      questionImageAdding: (requestId) => options.interactions.questionImageOperationIds.has(requestId),
      transcriptScroll: options.transcriptScroll,
      workspaceController: options.workspaceController,
      preview: options.project.preview,
      transcriptAttachments: options.transcriptAttachments,
      branchActions: options.conversation.branches,
      history: options.sessions.history,
      promptQueue: options.promptActions.queue,
      promptRuntime: options.prompt.runtime,
      autocomplete: options.sessions.autocomplete,
      draft: options.transitions.draft,
      conversationActions: options.conversation.actions,
      openHistoryPicker: options.conversation.navigation.openHistoryPicker,
      promptSubmit: options.promptActions.submit,
      handoff: options.promptActions.handoff,
      projectActions: options.projectActions.actions,
      attachments: options.interactions.attachments,
      elicitation: options.interactions.elicitation,
      questionImages: options.interactions.questionImages,
      lspOnboarding: options.lspOnboarding,
      quotaWait: options.quotaWait,
      headsUp: options.headsUp,
      openBtw: options.openBtw,
      openClaudeLoginTerminal: options.openClaudeLoginTerminal,
      reportClaudeLoginError: options.errors.report,
    },
    editor: {
      workspace: options.workspace,
      statusReady: () => options.status() === "ready",
      clientAvailable: options.clientAvailable,
      operationRunning: options.operationRunning,
      activeWorkbenchTabId: options.activeWorkbenchTabId,
      terminalOpen: () => options.presentation.workbenchTabs.some((tab) => tab.id === "terminal"),
      externalEditorLabel: () => externalEditorLabel(options.project.workspace.externalEditor),
      preview: options.project.preview,
      projectDocuments: options.project.documents,
      projectWorkspace: options.project.workspace,
      git: options.project.git,
      gitAssist: options.workbenchGit.gitAssist,
      knowledgeResolution: options.workbenchGit.knowledgeResolution,
      lspOnboarding: options.lspOnboarding,
      wikiConflicts: options.workbenchWikiConflicts ? {
        state: options.workbenchWikiConflicts,
        recheck: options.project.wikiConflictsRecheck,
        read: async (workspace, path, signal) => {
          signal.throwIfAborted();
          const file = await invoke<ProjectFilePreview>("read_project_file", { workspace, path });
          signal.throwIfAborted();
          return file.content;
        },
        reportError: (error) => createDiagnosticLogger(() => ({ workspace: options.workspace() }))
          .warn("wiki:conflicts-compare-read-failed", error),
        dates: async (workspace, request, signal) => {
          try {
            signal.throwIfAborted();
            const dates = await invoke<WikiFileDates>("wiki_file_dates", {
              workspace, path: request.path, startLine: request.lines?.startLine, endLine: request.lines?.endLine,
            });
            return signal.aborted ? null : dates;
          } catch (error) {
            if (!signal.aborted) createDiagnosticLogger(() => ({ workspace: options.workspace() }))
              .warn("wiki:conflicts-file-dates-failed", error);
            return null;
          }
        },
        decisionWriter: options.project.documents.knowledgeDecisionWriter,
        refresh: () => options.project.wikiConsistency.refresh(),
        reportDecisionError: (error) => {
          createDiagnosticLogger(() => ({ workspace: options.workspace() })).warn("wiki:finding-decision-failed", error);
          options.errors.report(error);
        },
        editWriter: options.project.documents.wikiEditWriter,
        reportEditError: (error) => {
          createDiagnosticLogger(() => ({ workspace: options.workspace() })).warn("wiki:side-edit-failed", error);
          options.errors.report(error);
        },
        tasks: {
          prepare: async (workspace) => {
            const tasks = options.project.tasks;
            if (options.workspace() !== workspace || tasks.saving) return false;
            await tasks.load(workspace);
            return options.workspace() === workspace && !tasks.loading && !tasks.loadFailed && !tasks.saving;
          },
          newId: () => options.project.tasks.newId(),
          create: (draft) => options.project.tasks.create(draft),
          open: (taskId) => options.openTasksPanel?.(taskId),
        },
        offerDecisionUndo: (offer) => {
          const text = wikiConflictsText(offer.finding.reportLanguage);
          toasts.info({
            message: offer.decision ? text.decisionSaved(wikiVerdictLabel(text, offer.finding, offer.decision.verdict))
              : text.decisionCleared,
            source: text.heading,
            key: offer.key,
            durationMs: WIKI_DECISION_UNDO_MS,
            actions: [{ label: text.undo, run: async () => { await offer.undo(); } }],
          });
        },
      } : undefined,
    },
  });
}
