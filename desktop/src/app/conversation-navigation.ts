import { tick } from "svelte";
import type { AcpClient } from "../lib/acp-client";
import { listCommandPickerState, type CommandPickerState, type CommandPickerItem } from "../lib/command-interactions";
import { desktopCommandShortcutLabel, type DesktopShortcutPlatform } from "../lib/desktop-commands";
import {
  applySessionUpdates,
  emptyTranscript,
  markDeferredToolResults,
  type MessageItem,
  type TranscriptState,
} from "../lib/transcript";
import { compactPickerText, normalizedPromptText } from "./desktop-helpers";

type ConversationNavigationOptions = {
  client: () => AcpClient | null;
  activeSessionId: () => string | null;
  activeSessionRuntimeReady: () => boolean;
  workspace: () => string;
  transcript: () => TranscriptState;
  setTranscript: (sessionId: string, transcript: TranscriptState) => void;
  setPicker: (picker: CommandPickerState | null) => void;
  scrollToEntry: (entryId: string) => void;
  appendSystemMessage: (text: string) => void;
  scheduleScrollToLatest: () => void;
  platform: DesktopShortcutPlatform;
  reportError: (error: unknown) => void;
};

function transcriptUserEntryId(
  messages: readonly { entryId: string; text: string }[],
  targetEntryId: string,
  state: TranscriptState,
): string | undefined {
  const users = state.items.filter((item): item is MessageItem => item.type === "message" && item.role === "user");
  const targetIndex = messages.findIndex((message) => message.entryId === targetEntryId);
  if (targetIndex >= 0 && users.length === messages.length) return users[targetIndex]?.id;
  let userIndex = 0;
  for (const message of messages) {
    const target = normalizedPromptText(message.text);
    let matchIndex = -1;
    for (let index = userIndex; index < users.length; index += 1) {
      if (normalizedPromptText(users[index]!.text) === target) {
        matchIndex = index;
        break;
      }
    }
    if (matchIndex < 0) continue;
    const visible = users[matchIndex]!;
    userIndex = matchIndex + 1;
    if (message.entryId === targetEntryId) return visible.id;
  }
  return undefined;
}

export function createConversationNavigation(options: ConversationNavigationOptions) {
  async function openJumpPicker(query: string): Promise<void> {
    const requestClient = options.client();
    const sessionId = options.activeSessionId();
    if (!requestClient || !sessionId || !options.activeSessionRuntimeReady()) return;
    try {
      const messages = await requestClient.forkMessages(sessionId);
      if (requestClient !== options.client() || sessionId !== options.activeSessionId()) return;
      const items: CommandPickerItem[] = messages.map((message) => ({
        id: `jump:${message.entryId}`,
        value: message.entryId,
        label: compactPickerText(message.text, 110),
        description: message.entryId,
      }));
      options.setPicker(listCommandPickerState("jump", items, query));
    } catch (error) {
      options.reportError(error);
    }
  }

  async function jumpToUserMessage(entryId: string): Promise<void> {
    const requestClient = options.client();
    const sessionId = options.activeSessionId();
    const requestWorkspace = options.workspace();
    if (!requestClient || !sessionId || !options.activeSessionRuntimeReady()) return;
    try {
      const messages = await requestClient.forkMessages(sessionId);
      if (requestClient !== options.client() || sessionId !== options.activeSessionId()) return;
      let state = options.transcript();
      let visibleId = transcriptUserEntryId(messages, entryId, state);
      if (!visibleId) {
        const history = await requestClient.sessionHistory(sessionId, true);
        if (
          requestClient !== options.client()
          || sessionId !== options.activeSessionId()
          || requestWorkspace !== options.workspace()
        ) return;
        let loaded = applySessionUpdates(emptyTranscript, history.updates);
        loaded = markDeferredToolResults(loaded, history.deferredToolCallIds);
        const systemItems = state.items.filter((item) => item.type === "message" && item.role === "system");
        state = systemItems.length > 0 ? { items: [...loaded.items, ...systemItems] } : loaded;
        options.setTranscript(sessionId, state);
        visibleId = transcriptUserEntryId(messages, entryId, state);
      }
      if (!visibleId) throw new Error("Could not locate that user message in the loaded session history.");
      await tick();
      options.scrollToEntry(visibleId);
    } catch (error) {
      options.reportError(error);
    }
  }

  async function openHistoryPicker(query: string): Promise<void> {
    const requestClient = options.client();
    const sessionId = options.activeSessionId();
    if (!requestClient || !sessionId || !options.activeSessionRuntimeReady()) return;
    try {
      const entries = await requestClient.requestHistory(sessionId);
      if (requestClient !== options.client() || sessionId !== options.activeSessionId()) return;
      const items: CommandPickerItem[] = entries.map((entry, index) => ({
        id: `history:${index}`,
        value: entry,
        label: compactPickerText(entry, 120),
        description: entry.includes("\n") ? compactPickerText(entry.replace(/\n+/gu, " ↵ "), 180) : undefined,
      }));
      options.setPicker(listCommandPickerState("history", items, query));
    } catch (error) {
      options.reportError(error);
    }
  }

  function showHotkeys(): void {
    if (!options.activeSessionId()) return;
    options.appendSystemMessage([
      "Keyboard shortcuts",
      "Enter: send message / accept selected slash command",
      "Shift+Enter: insert a newline",
      "While Pix is responding, Enter queues the draft as steering for the next turn",
      "Pause button or /queue <message>: hold a message until you send it from the queue panel",
      "Tab: accept the selected slash command or inline autocomplete",
      "Esc: close the active slash menu, picker, or dialog",
      "Up/Down: move through slash-command and picker results",
      `${desktopCommandShortcutLabel("application.commandPalette", options.platform)}: open the command palette`,
      `${desktopCommandShortcutLabel("session.new", options.platform)}: open a fresh conversation tab`,
      "Left/Right on the tab strip: move keyboard focus between conversation tabs",
      "Home/End on the tab strip: move focus to the first/last conversation tab",
      "Delete on a focused conversation tab: close that tab",
      "/new_tab: open a fresh conversation tab",
      "/search: search saved conversations",
      "/jump: jump to a visible previous user message",
      "/history: restore a previous prompt into the composer",
    ].join("\n"));
    options.scheduleScrollToLatest();
  }

  return { openJumpPicker, jumpToUserMessage, openHistoryPicker, showHotkeys };
}
