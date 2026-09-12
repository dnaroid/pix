import type { Attachment } from "../lib/attachments";
import type {
  PendingElicitation,
  PendingQuestionElicitation,
} from "./elicitation.svelte";

export type QuestionImageControllerOptions = {
  activePendingElicitation: () => PendingElicitation | null;
  pendingQuestion: (requestId: number) => PendingQuestionElicitation | null;
  replacePending: (pending: PendingElicitation) => void;
  questionImageOperationIds: () => Map<number, number>;
  setQuestionImageOperationIds: (ids: Map<number, number>) => void;
  workspace: () => string;
  activeSessionId: () => string | null;
  draftSessionTabActive: () => boolean;
  sessionMutationRunning: () => boolean;
  setErrorMessage: (message: string) => void;
  reportError: (error: unknown) => void;
  nextAttachmentId: () => string;
  activateAttachment: (attachment: Attachment) => void | Promise<void>;
};
