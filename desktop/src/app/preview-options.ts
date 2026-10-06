import type { Attachment } from "../lib/attachments";
import type { WorkbenchTabId } from "../lib/workbench-tabs";

export type PreviewStoreOptions = {
  workspace: () => string;
  revealProjectEntry?: (path: string) => Promise<void>;
  loadExternalEditor: () => Promise<string | undefined>;
  activeWorkbenchTabId: () => WorkbenchTabId | null;
  activeConversationWorkbenchTabId: () => WorkbenchTabId | null;
  setActiveWorkbenchTabId: (id: WorkbenchTabId | null) => void;
  nextWorkbenchAuxOrder: () => number;
  prepareAttachment: (attachment: Attachment) => Promise<void>;
  preparedAttachment: (attachment: Attachment) => Attachment;
  reportError: (error: unknown) => void;
  setErrorMessage: (message: string) => void;
};
