import { elicitationBelongsToActiveSession } from "../lib/elicitation";
import type { Attachment } from "../lib/attachments";
import type { ActiveSessionState } from "./active-session-state.svelte";
import { createAttachmentDraftController } from "./attachment-drafts";
import {
  createElicitationStore,
  type PendingElicitation,
} from "./elicitation.svelte";
import { createQuestionImageController } from "./question-images";

type DesktopInteractionServicesOptions = {
  workspace: () => string;
  state: ActiveSessionState;
  draftSessionTabActive: () => boolean;
  sessionMutationRunning: () => boolean;
  operationRunning: () => boolean;
  attachmentDraftKey: () => string;
  promptAttachments: () => Attachment[];
  setPromptAttachments: (attachments: Attachment[]) => void;
  activateAttachment: (attachment: Attachment) => void | Promise<void>;
  setErrorMessage: (message: string) => void;
  reportError: (error: unknown) => void;
};

export function createDesktopInteractionServices(options: DesktopInteractionServicesOptions) {
  const attachments = createAttachmentDraftController({
    workspace: options.workspace,
    activeSessionId: () => options.state.sessionId,
    draftSessionTabActive: options.draftSessionTabActive,
    sessionMutationRunning: options.sessionMutationRunning,
    operationRunning: options.operationRunning,
    attachmentDraftKey: options.attachmentDraftKey,
    promptAttachments: options.promptAttachments,
    setPromptAttachments: options.setPromptAttachments,
    setErrorMessage: options.setErrorMessage,
    reportError: options.reportError,
  });

  let questionImageOperationIds = $state<Map<number, number>>(new Map());
  let questionImages!: ReturnType<typeof createQuestionImageController>;

  const elicitation = createElicitationStore({
    cancelQuestionImageOperation: (requestId) => questionImages.cancelQuestionImageOperation(requestId),
    activeSessionId: () => options.state.sessionId,
  });
  const activePendingElicitation = $derived.by<PendingElicitation | null>(() => {
    const activeSessionId = options.state.sessionId;
    const pending = elicitation.pendingUnscoped
      ?? (activeSessionId ? elicitation.pendingBySession.get(activeSessionId) ?? null : null);
    return pending && elicitationBelongsToActiveSession(pending.sessionId, activeSessionId) ? pending : null;
  });
  const pendingElicitationSessionIds = $derived.by<ReadonlySet<string>>(() => {
    const activeSessionId = options.state.sessionId;
    const sessionIds = new Set(elicitation.pendingBySession.keys());
    if (elicitation.pendingUnscoped && activeSessionId) sessionIds.add(activeSessionId);
    return sessionIds;
  });

  questionImages = createQuestionImageController({
    activePendingElicitation: () => activePendingElicitation,
    pendingQuestion: elicitation.pendingQuestion,
    replacePending: elicitation.replace,
    questionImageOperationIds: () => questionImageOperationIds,
    setQuestionImageOperationIds: (ids) => questionImageOperationIds = ids,
    workspace: options.workspace,
    activeSessionId: () => options.state.sessionId,
    draftSessionTabActive: options.draftSessionTabActive,
    sessionMutationRunning: options.sessionMutationRunning,
    setErrorMessage: options.setErrorMessage,
    reportError: options.reportError,
    nextAttachmentId: attachments.nextAttachmentId,
    activateAttachment: options.activateAttachment,
  });

  return {
    attachments,
    elicitation,
    questionImages,
    get activePendingElicitation() { return activePendingElicitation; },
    get pendingElicitationSessionIds() { return pendingElicitationSessionIds; },
    get questionImageOperationIds() { return questionImageOperationIds; },
  };
}

export type DesktopInteractionServices = ReturnType<typeof createDesktopInteractionServices>;
