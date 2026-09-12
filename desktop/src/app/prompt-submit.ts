import { getCurrentWindow } from "@tauri-apps/api/window";
import type { SessionConfigOption } from "@agentclientprotocol/sdk";
import type { AcpClient } from "../lib/acp-client";
import type { Attachment } from "../lib/attachments";
import { commandPickerState, type CommandPickerState } from "../lib/command-interactions";
import { parseDesktopSlashCommand } from "../lib/slash-commands";
import { buildPromptPayload } from "./prompt-payload";
import type { createPromptRuntime } from "./prompt-runtime.svelte";

type PromptRuntime = ReturnType<typeof createPromptRuntime>;

type PromptSubmitOptions = {
  client: () => AcpClient | null;
  sessionMutationRunning: () => boolean;
  sessionHistoryLoading: () => boolean;
  waitForAttachmentDraftSettled: (key: string) => Promise<void>;
  attachmentDraftKey: () => string;
  attachmentGeneration: () => number;
  promptText: () => string;
  promptAttachments: () => readonly Attachment[];
  setPromptText: (text: string) => void;
  activeSessionId: () => string | null;
  draftSessionTabActive: () => boolean;
  materializeDraftSession: () => Promise<string | null>;
  activeSessionRuntimeReady: () => boolean;
  promptRunning: () => boolean;
  openSessionStartTab: () => void | Promise<void>;
  enhancePromptDraft: (draft: string) => void | Promise<void>;
  importConversationPath: (path: string) => void | Promise<void>;
  chooseImportSession: () => void | Promise<void>;
  requestLocalTextInput: (message: string, title: string) => Promise<string | undefined>;
  deferDraft: (
    text: string,
    attachments: readonly Attachment[],
    options: { clearComposer: boolean },
  ) => Promise<void>;
  resumeConversationPath: (path: string) => void | Promise<void>;
  openSessionSelector: (query?: string, mode?: "open" | "delete") => void;
  openJumpPicker: (query: string) => void | Promise<void>;
  openHistoryPicker: (query: string) => void | Promise<void>;
  showDesktopHotkeys: () => void;
  reloadResources: (options?: { echo?: boolean }) => Promise<void>;
  forkConversation: (entryId?: string) => Promise<void>;
  closeProjectSelector: () => void;
  closeSessionSelector: () => void;
  applyModelSlashCommand: (value: string) => void | Promise<void>;
  applyThinkingSlashCommand: (level: string) => void | Promise<void>;
  setCommandPicker: (picker: CommandPickerState | null) => void;
  displayedConfigOptions: () => readonly SessionConfigOption[];
  queueDraftForCurrentRun: (
    text: string,
    attachments: readonly Attachment[],
    draftKey: string,
    draftGeneration: number,
  ) => Promise<void>;
  imagePromptSupported: () => boolean;
  invalidateAttachmentDraft: () => void;
  nextLocalMessageId: () => string;
  appendUserMessage: (text: string, id: string, attachments: readonly Attachment[]) => void;
  scrollToLatest: () => Promise<void>;
  prompts: PromptRuntime;
  refreshAutocompleteSettings: (sessionId: string) => Promise<void>;
  refreshSessions: () => void | Promise<void>;
  setErrorMessage: (message: string | null) => void;
  reportError: (error: unknown) => void;
};

export function createPromptSubmit(options: PromptSubmitOptions) {
  async function submit(): Promise<void> {
    if (!options.client() || options.sessionMutationRunning() || options.sessionHistoryLoading()) return;
    const initialDraftKey = options.attachmentDraftKey();
    await options.waitForAttachmentDraftSettled(initialDraftKey);
    if (initialDraftKey !== options.attachmentDraftKey()) return;
    const text = options.promptText().trim();
    const attachments = options.promptAttachments();
    let sessionId = options.activeSessionId();
    let draftKey = options.attachmentDraftKey();
    let draftGeneration = options.attachmentGeneration();
    if (
      !options.client()
      || (!text && attachments.length === 0)
      || options.sessionMutationRunning()
      || options.sessionHistoryLoading()
    ) return;

    const desktopCommand = parseDesktopSlashCommand(text, attachments.length > 0);
    if (desktopCommand) {
      switch (desktopCommand.kind) {
        case "new":
        case "new_tab":
          if (options.promptRunning()) return;
          options.setPromptText("");
          await options.openSessionStartTab();
          break;
        case "enhance":
          if (options.promptRunning()) return;
          options.setPromptText("");
          await options.enhancePromptDraft(desktopCommand.draft);
          break;
        case "import":
          if (options.promptRunning()) return;
          options.setPromptText("");
          if (desktopCommand.path) await options.importConversationPath(desktopCommand.path);
          else await options.chooseImportSession();
          break;
        case "queue": {
          let message = desktopCommand.message;
          if (!message && attachments.length === 0) {
            message = await options.requestLocalTextInput("Enter the message to pause and send later.", "Queued message") ?? "";
          }
          if (!message && attachments.length === 0) return;
          await options.deferDraft(message, attachments, { clearComposer: true });
          break;
        }
        case "resume":
          if (options.promptRunning()) return;
          options.setPromptText("");
          if (desktopCommand.path) await options.resumeConversationPath(desktopCommand.path);
          else options.openSessionSelector();
          break;
        case "search":
          options.setPromptText("");
          options.openSessionSelector(desktopCommand.query, "open");
          break;
        case "delete":
          if (options.promptRunning()) return;
          options.setPromptText("");
          options.openSessionSelector(desktopCommand.query, "delete");
          break;
        case "jump":
          options.setPromptText("");
          await options.openJumpPicker(desktopCommand.query);
          break;
        case "history":
          options.setPromptText("");
          await options.openHistoryPicker(desktopCommand.query);
          break;
        case "hotkeys":
          options.setPromptText("");
          options.showDesktopHotkeys();
          break;
        case "quit":
          options.setPromptText("");
          await getCurrentWindow().close();
          break;
        case "reload":
          if (options.promptRunning()) return;
          options.setPromptText("");
          await options.reloadResources();
          break;
        case "fork":
          if (options.promptRunning()) return;
          options.setPromptText("");
          await options.forkConversation(desktopCommand.entryId);
          break;
        case "model":
          if (options.promptRunning()) return;
          options.setPromptText("");
          options.closeProjectSelector();
          options.closeSessionSelector();
          if (desktopCommand.value) await options.applyModelSlashCommand(desktopCommand.value);
          else options.setCommandPicker(commandPickerState("model", [...options.displayedConfigOptions()]));
          break;
        case "thinking":
          if (options.promptRunning()) return;
          options.setPromptText("");
          options.closeProjectSelector();
          options.closeSessionSelector();
          if (desktopCommand.level) await options.applyThinkingSlashCommand(desktopCommand.level);
          else options.setCommandPicker(commandPickerState("thinking", [...options.displayedConfigOptions()]));
          break;
      }
      return;
    }

    if (!sessionId) {
      if (!options.draftSessionTabActive()) return;
      sessionId = await options.materializeDraftSession();
      if (!sessionId) return;
      draftKey = options.attachmentDraftKey();
      draftGeneration = options.attachmentGeneration();
    }
    if (!options.activeSessionRuntimeReady()) return;

    if (options.promptRunning()) {
      if (text.startsWith("/")) {
        options.reportError(new Error(
          "Slash commands cannot run while the agent is responding. Use /queue to pause a message for later.",
        ));
        return;
      }
      await options.queueDraftForCurrentRun(text, attachments, draftKey, draftGeneration);
      return;
    }

    let reloadAfterSlash = false;
    options.setErrorMessage(null);
    try {
      const { blocks, fileImages } = buildPromptPayload(text, attachments, options.imagePromptSupported());
      if (
        sessionId !== options.activeSessionId()
        || draftKey !== options.attachmentDraftKey()
        || draftGeneration !== options.attachmentGeneration()
        || attachments !== options.promptAttachments()
      ) return;
      options.setPromptText("");
      options.invalidateAttachmentDraft();
      const transcriptMessageId = options.nextLocalMessageId();
      options.appendUserMessage(text, transcriptMessageId, attachments);
      await options.scrollToLatest();
      const requestClient = options.client();
      if (!requestClient) return;
      await options.prompts.runPromptRequest(requestClient, sessionId, blocks, fileImages, transcriptMessageId);
      if (text.startsWith("/")) await options.refreshAutocompleteSettings(sessionId);
      reloadAfterSlash = /^\/(?:scoped-models|no-context-files)(?:\s|$)/i.test(text);
      void options.refreshSessions();
    } catch (error) {
      options.reportError(error);
    }
    if (reloadAfterSlash && sessionId === options.activeSessionId()) await options.reloadResources({ echo: false });
  }

  return { submit };
}
