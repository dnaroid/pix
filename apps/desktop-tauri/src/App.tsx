import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { invoke, Channel } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import {
  Sparkles,
  Square,
  User,
  Bot,
  AlertCircle,
  Wrench,
  ChevronDown,
  ChevronRight,
  Plus,
  RefreshCw,
  X,
  FolderOpen,
  Cpu,
  Gauge,
  Brain,
  Image as ImageIcon,
  Mic,
  MicOff,
  Search,
  Clock3,
  Activity,
  PanelTop,
  PanelBottom,
  Puzzle,
  Keyboard,
} from "lucide-react";
import { lookup, defaultRenderer } from "./tools";
import type { ToolRenderProps } from "./tools/types";
import { RawTerminal } from "./RawTerminal";
import { getCurrentWindow } from "@tauri-apps/api/window";
import "./App.css";

const WORKSPACE_KEY = "pix-desktop.workspace";
const TABS_KEY_PREFIX = "pix-desktop.tabs:";
const INITIAL_MESSAGE_CHUNK = 80;
const BACKFILL_MESSAGE_CHUNK = 240;
const LOAD_OLDER_SCROLL_THRESHOLD_PX = 80;
const VIRTUAL_OVERSCAN_PX = 360;
const ESTIMATED_MESSAGE_HEIGHT = 96;
const INITIAL_VIEWPORT_BEFORE = 80;
const INITIAL_VIEWPORT_AFTER = 160;

// -- RPC event shape (flat: optional fields, narrowing via switch) --------

type AssistantMessageEvent = {
  type: string;
  delta?: string;
};

type RpcEvent = {
  type: string;
  message?: { role?: string };
  assistantMessageEvent?: AssistantMessageEvent;
  toolCallId?: string;
  toolName?: string;
  args?: unknown;
  result?: unknown;
  isError?: boolean;
  event?: string;
  error?: string;
};

// -- Local chat model -----------------------------------------------------

type TextPart = { kind: "text"; text: string };
type ToolPart = {
  kind: "tool";
  toolCallId: string;
  name: string;
  args: unknown;
  status: "running" | "done" | "error";
  result?: unknown;
};
type AssistantPart = TextPart | ToolPart;

type ChatMessage =
  | { id: string; role: "user"; text: string; attachments?: ImageAttachment[]; entryOffset?: number }
  | { id: string; role: "assistant"; parts: AssistantPart[]; entryOffset?: number };

type ImageAttachment = {
  id: string;
  name: string;
  mimeType: string;
  data: string;
  size: number;
};

type HistoryContent =
  | { type: "text"; text?: string }
  | { type: "thinking" }
  | { type: "image" }
  | { type: "toolCall"; id?: string; name?: string; arguments?: unknown };

type HistoryMessage =
  | { role: "user"; content?: string | HistoryContent[]; __pixSessionEntryId?: string }
  | { role: "assistant"; content?: HistoryContent[]; __pixSessionEntryId?: string }
  | { role: "toolResult"; toolCallId?: string; toolName?: string; content?: HistoryContent[]; details?: unknown; isError?: boolean; __pixSessionEntryId?: string }
  | { role?: string; [k: string]: unknown };

type MessagesPage = {
  messages: HistoryMessage[];
  offset: number;
  total: number;
  hasOlder?: boolean;
  startIndex?: number;
  endIndex?: number;
  hasNewer?: boolean;
  cursor?: TabScrollState;
};

type HistoryLoadProgress = {
  loaded: number;
  total: number;
  complete?: boolean;
};

type OlderHistoryState = {
  nextOffset: number;
  hasExternalOlder: boolean;
  loading: boolean;
};

type NewerHistoryState = {
  nextOffset: number;
  hasNewer: boolean;
  loading: boolean;
  gapBytes?: number;
};

type TabScrollState = {
  followOutput: boolean;
  anchorId?: string;
  anchorOffset?: number;
  anchorEntryOffset?: number;
};

type VirtualRange = {
  start: number;
  end: number;
  before: number;
  after: number;
};

type SessionSummary = {
  path: string;
  id: string;
  cwd: string;
  name?: string;
  parentSessionPath?: string;
  created: string;
  modified: string;
  messageCount: number;
  firstMessage: string;
};

type SessionState = {
  sessionId?: string;
  sessionFile?: string;
  sessionName?: string;
  messageCount?: number;
  isStreaming?: boolean;
  isCompacting?: boolean;
  model?: ModelInfo | null;
  thinkingLevel?: string;
  contextUsage?: ContextUsageInfo;
};

type ShellRunResult = {
  code: number | null;
  signal: number | null;
  stdout: string;
  stderr: string;
  timed_out: boolean;
};

/** Subset of SDK Model we care about in the UI. Passed through as-is from sidecar. */
type ModelInfo = {
  id?: string;
  name?: string;
  provider?: string;
  contextWindow?: number;
  reasoning?: boolean;
};

/** Mirrors SDK ContextUsage. */
type ContextUsageInfo = {
  tokens: number | null;
  contextWindow: number;
  percent: number | null;
};

type PersistedTabs = {
  openTabs: string[];
  activeTabId: string | null;
  titles?: Record<string, string>;
  scroll?: Record<string, TabScrollState>;
};

type SlashCommandDef = {
  name: string;
  description: string;
  source?: "desktop" | "extension" | "prompt" | "skill";
  disabled?: boolean;
};

type SlashCompletionItem = {
  label: string;
  value: string;
  description?: string;
  kind?: "arg" | "model" | "path";
};

type ComposerCompletionTarget =
  | { kind: "slash-arg"; command: string; prefix: string }
  | { kind: "path"; prefix: string; replaceStart: number; replaceEnd: number; trigger: "shell" | "mention" | "slash" };

type SdkSlashCommand = {
  name: string;
  description?: string;
  source?: "extension" | "prompt" | "skill";
};

type DesktopModel = {
  id: string;
  name: string;
  provider: string;
  ref: string;
  reasoning?: boolean;
  contextWindow?: number;
  current?: boolean;
};

type ExtensionUIMethod =
  | "select"
  | "confirm"
  | "input"
  | "editor"
  | "notify"
  | "setStatus"
  | "setWidget"
  | "setWorkingMessage"
  | "setWorkingVisible"
  | "setWorkingIndicator"
  | "setHiddenThinkingLabel"
  | "setHeader"
  | "setFooter"
  | "custom"
  | "setWidgetComponent"
  | "setEditorComponent"
  | "addAutocompleteProvider"
  | "setTitle"
  | "set_editor_text";

type ExtensionUIRequest = RpcEvent & {
  id?: string;
  method?: ExtensionUIMethod;
  title?: string;
  message?: string;
  options?: string[];
  timeout?: number;
  placeholder?: string;
  prefill?: string;
  notifyType?: "info" | "warning" | "error";
  statusKey?: string;
  statusText?: string;
  workingMessage?: string;
  workingVisible?: boolean;
  workingIndicatorFrames?: string[];
  hiddenThinkingLabel?: string;
  active?: boolean;
  overlay?: boolean;
  widgetKey?: string;
  widgetLines?: string[];
  widgetPlacement?: "aboveEditor" | "belowEditor";
  text?: string;
};

type ExtensionToast = { id: string; message: string; type: "info" | "warning" | "error" };
type ExtensionWidget = { key: string; lines: string[]; placement: "aboveEditor" | "belowEditor"; degradedComponent?: boolean };
type ExtensionChromeState = {
  workingMessage?: string;
  workingVisible?: boolean;
  workingIndicatorFrames?: string[];
  hiddenThinkingLabel?: string;
  headerActive?: boolean;
  footerActive?: boolean;
  customUiRequested?: boolean;
  editorComponentActive?: boolean;
  autocompleteProviderActive?: boolean;
};

type SpeechRecognitionConstructor = new () => SpeechRecognitionLike;

type SpeechRecognitionLike = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((event: SpeechRecognitionResultEventLike) => void) | null;
  onerror: ((event: { error?: string }) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
};

type SpeechRecognitionResultEventLike = {
  resultIndex: number;
  results: ArrayLike<{ isFinal: boolean; 0?: { transcript?: string } }>;
};

type SpeechWindow = Window & {
  SpeechRecognition?: SpeechRecognitionConstructor;
  webkitSpeechRecognition?: SpeechRecognitionConstructor;
};

const BASE_SLASH_COMMANDS: SlashCommandDef[] = [
  { name: "/help", description: "Show available Pix Desktop commands", source: "desktop" },
  { name: "/model", description: "Select an available model", source: "desktop" },
  { name: "/compact", description: "Compact the current session context", source: "desktop" },
  { name: "/undo", description: "Navigate back to the last user turn", source: "desktop" },
  { name: "/new", description: "Start a new session", source: "desktop" },
  { name: "/clear", description: "Clear the visible chat for this tab", source: "desktop" },
  { name: "/refresh", description: "Refresh session list and status", source: "desktop" },
  { name: "/abort", description: "Stop the current agent run", source: "desktop" },
];

let nextId = 0;
const genId = (prefix: string) => `${prefix}-${++nextId}`;

// -- Component ------------------------------------------------------------

export default function App() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [attachments, setAttachments] = useState<ImageAttachment[]>([]);
  const [voiceSupported, setVoiceSupported] = useState(false);
  const [voiceListening, setVoiceListening] = useState(false);
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const [rawTerminal, setRawTerminal] = useState<{ key: number; command?: string } | null>(null);
  const [slashIndex, setSlashIndex] = useState(0);
  const [slashCompletionIndex, setSlashCompletionIndex] = useState(0);
  const [slashCompletions, setSlashCompletions] = useState<SlashCompletionItem[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [sdkSlashCommands, setSdkSlashCommands] = useState<SlashCommandDef[]>([]);
  const [availableModels, setAvailableModels] = useState<DesktopModel[]>([]);
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const [modelPickerQuery, setModelPickerQuery] = useState("");
  const [extensionDialog, setExtensionDialog] = useState<ExtensionUIRequest | null>(null);
  const [extensionDialogValue, setExtensionDialogValue] = useState("");
  const [extensionToasts, setExtensionToasts] = useState<ExtensionToast[]>([]);
  const [extensionStatuses, setExtensionStatuses] = useState<Record<string, string>>({});
  const [extensionWidgets, setExtensionWidgets] = useState<Record<string, ExtensionWidget>>({});
  const [extensionChrome, setExtensionChrome] = useState<ExtensionChromeState>({});
  const [session, setSession] = useState<SessionState>({});
  const [, setLoadingSessions] = useState(false);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [historyLoadProgress, setHistoryLoadProgress] = useState<HistoryLoadProgress | null>(null);
  const [olderHistory, setOlderHistory] = useState<OlderHistoryState>({ nextOffset: 0, hasExternalOlder: false, loading: false });
  const [newerHistory, setNewerHistory] = useState<NewerHistoryState>({ nextOffset: 0, hasNewer: false, loading: false });
  const [virtualRange, setVirtualRange] = useState<VirtualRange>({ start: 0, end: 0, before: 0, after: 0 });
  const [restoredTabTitles, setRestoredTabTitles] = useState<Record<string, string>>({});
  const [workspace, setWorkspace] = useState<string | null>(() => {
    try {
      return localStorage.getItem(WORKSPACE_KEY);
    } catch {
      return null;
    }
  });
  const [switchingWorkspace, setSwitchingWorkspace] = useState(false);
  // Tabs: each tab is a sessionFile path. activeTabId is the currently focused
  // tab (the one the sidecar is bound to). Per-tab messages are cached so
  // switching tabs feels instant; live event streaming only targets the
  // active tab (sidecar has a single active session at a time).
  const [openTabs, setOpenTabs] = useState<string[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const tabMessagesRef = useRef<Map<string, ChatMessage[]>>(new Map());
  const activeTabIdRef = useRef<string | null>(null);
  const pendingSessionSwitchRef = useRef<string | null>(null);
  const suppressNextSessionSyncRef = useRef<string | null>(null);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const appliedWorkspaceRef = useRef<string | null>(null);
  const hydratedTabsWorkspaceRef = useRef<string | null>(null);
  const historyLoadSeqRef = useRef(0);
  const historyLoadInFlightRef = useRef<string | null>(null);
  const sessionMessageCountRef = useRef(0);
  const prependScrollAnchorRef = useRef<{ anchorId?: string; anchorOffset?: number } | null>(null);
  const scrollToBottomNextRenderRef = useRef(false);
  const followOutputRef = useRef(true);
  const tabScrollRef = useRef<Map<string, TabScrollState>>(new Map());
  const restoreScrollNextRenderRef = useRef<{ path: string; followOutput: boolean; anchorId?: string; anchorOffset?: number } | null>(null);
  const suppressNextScrollCaptureRef = useRef(false);
  const messageHeightsRef = useRef<Map<string, number>>(new Map());
  const scrollRef = useRef<HTMLDivElement>(null);
  /** Mirror of `messages` so stable callbacks can read the latest value. */
  const messagesRef = useRef<ChatMessage[]>([]);

  useEffect(() => {
    const speechWindow = window as SpeechWindow;
    setVoiceSupported(Boolean(speechWindow.SpeechRecognition ?? speechWindow.webkitSpeechRecognition));
    return () => {
      recognitionRef.current?.abort();
      recognitionRef.current = null;
    };
  }, []);
  useLayoutEffect(() => {
    messagesRef.current = messages;
  }, [messages]);
  useEffect(() => {
    activeTabIdRef.current = activeTabId;
  }, [activeTabId]);
  useEffect(() => {
    sessionMessageCountRef.current = session.messageCount ?? 0;
  }, [session.messageCount]);

  const clearExtensionSurface = useCallback(() => {
    setExtensionDialog(null);
    setExtensionDialogValue("");
    setExtensionStatuses({});
    setExtensionWidgets({});
    setExtensionChrome({});
  }, []);

  useEffect(() => {
    clearExtensionSurface();
  }, [activeTabId, clearExtensionSurface, workspace]);

  const workspaceTitle = workspace ? workspaceBasename(workspace) : "Pix Desktop";
  const sessionTitle = useMemo(() => {
    if (!workspace) return "";
    return activeTabId ? sessionLabelFor(activeTabId, sessions, session, restoredTabTitles) : "Session";
  }, [workspace, activeTabId, sessions, session, restoredTabTitles]);

  const renderedMessages = useMemo(() => {
    const rangeLooksUsable =
      virtualRange.end > virtualRange.start &&
      virtualRange.start >= 0 &&
      virtualRange.end <= messages.length;
    const fallbackCount = Math.min(
      messages.length,
      Math.max(1, Math.ceil(((scrollRef.current?.clientHeight ?? window.innerHeight) + VIRTUAL_OVERSCAN_PX * 2) / ESTIMATED_MESSAGE_HEIGHT)),
    );
    const fallbackAfter = messages
      .slice(fallbackCount)
      .reduce((sum, message) => sum + (messageHeightsRef.current.get(message.id) ?? estimateMessageHeight(message)), 0);
    const range = rangeLooksUsable
      ? virtualRange
      : { start: 0, end: fallbackCount, before: 0, after: fallbackAfter };
    return {
      before: range.before,
      after: range.after,
      messages: messages.slice(range.start, range.end),
    };
  }, [messages, virtualRange]);
  const newerGapHeight = useMemo(
    () => estimatedHistoryGapHeight(newerHistory.gapBytes),
    [newerHistory.gapBytes],
  );

  const windowTitle = sessionTitle ? `${workspaceTitle} | ${sessionTitle}` : workspaceTitle;

  useEffect(() => {
    document.title = windowTitle;
    getCurrentWindow().setTitle(windowTitle).catch(console.error);
  }, [windowTitle]);

  const handleTopbarMouseDown = useCallback((event: MouseEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const target = event.target as HTMLElement | null;
    if (target?.closest("[data-no-window-drag]")) return;
    void getCurrentWindow().startDragging().catch(console.error);
  }, []);

  const subscribed = useRef(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const composerInputRef = useRef<HTMLTextAreaElement>(null);

  const resizeComposer = useCallback(() => {
    const ta = composerInputRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    const computed = window.getComputedStyle(ta);
    const borderV =
      (parseFloat(computed.borderTopWidth) || 0) + (parseFloat(computed.borderBottomWidth) || 0);
    const max = Math.floor(window.innerHeight * 0.5);
    // scrollHeight excludes borders; height (border-box) includes them — add the difference.
    const needed = ta.scrollHeight + borderV;
    ta.style.height = Math.max(40, Math.min(needed, max)) + "px";
  }, []);

  useLayoutEffect(() => {
    resizeComposer();
  }, [input, resizeComposer]);

  useEffect(() => {
    window.addEventListener("resize", resizeComposer);
    return () => window.removeEventListener("resize", resizeComposer);
  }, [resizeComposer]);

  // -- RPC helpers -------------------------------------------------------

  const listSessionsForActiveWorkspace = useCallback(async (): Promise<SessionSummary[]> => {
    if (!workspace) return [];
    const resp = await invoke<{ sessions: SessionSummary[] }>("list_workspace_sessions", { cwd: workspace });
    return resp.sessions;
  }, [workspace]);

  const refreshSessions = useCallback(async () => {
    if (!workspace) {
      setSessions([]);
      return;
    }
    // On startup `workspace` is restored from localStorage before the sidecar
    // has necessarily switched to that cwd. Listing too early returns sessions
    // for the sidecar/package cwd, which then makes the UI appear to restore
    // unrelated tabs.
    if (appliedWorkspaceRef.current !== workspace) return;
    setLoadingSessions(true);
    try {
      const nextSessions = await listSessionsForActiveWorkspace();
      setSessions(nextSessions);
      setRestoredTabTitles((prev) => pruneRestoredTabTitles(prev, nextSessions));
    } catch (e) {
      setError(`list sessions: ${String(e)}`);
    } finally {
      setLoadingSessions(false);
    }
  }, [listSessionsForActiveWorkspace, workspace]);

  const addImageFiles = useCallback(async (files: FileList | File[]) => {
    const imageFiles = Array.from(files).filter((file) => file.type.startsWith("image/"));
    if (imageFiles.length === 0) return;
    try {
      const nextAttachments = await Promise.all(imageFiles.map(readImageAttachment));
      setAttachments((prev) => [...prev, ...nextAttachments].slice(0, 8));
      setError(null);
    } catch (e) {
      setError(`attachment: ${String(e)}`);
    }
  }, []);

  const removeAttachment = useCallback((id: string) => {
    setAttachments((prev) => prev.filter((attachment) => attachment.id !== id));
  }, []);

  const toggleVoiceDictation = useCallback(() => {
    if (voiceListening) {
      recognitionRef.current?.stop();
      setVoiceListening(false);
      return;
    }

    const SpeechRecognition = (window as SpeechWindow).SpeechRecognition ?? (window as SpeechWindow).webkitSpeechRecognition;
    if (!SpeechRecognition) {
      setVoiceError("Voice dictation is not available in this WebView.");
      return;
    }

    setVoiceError(null);
    const recognition = new SpeechRecognition();
    recognition.continuous = true;
    recognition.interimResults = false;
    recognition.lang = navigator.language || "en-US";
    recognition.onresult = (event) => {
      const finalText: string[] = [];
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const result = event.results[i];
        const transcript = result[0]?.transcript?.trim();
        if (result.isFinal && transcript) finalText.push(transcript);
      }
      if (finalText.length > 0) {
        setInput((prev) => {
          const separator = prev.trim().length > 0 && !prev.endsWith(" ") ? " " : "";
          return `${prev}${separator}${finalText.join(" ")}`;
        });
      }
    };
    recognition.onerror = (event) => {
      setVoiceError(event.error ? `Voice dictation: ${event.error}` : "Voice dictation failed.");
      setVoiceListening(false);
    };
    recognition.onend = () => {
      if (recognitionRef.current === recognition) {
        recognitionRef.current = null;
        setVoiceListening(false);
      }
    };
    recognitionRef.current = recognition;
    try {
      recognition.start();
      setVoiceListening(true);
    } catch (e) {
      recognitionRef.current = null;
      setVoiceListening(false);
      setVoiceError(`Voice dictation: ${String(e)}`);
    }
  }, [voiceListening]);

  const refreshState = useCallback(async () => {
    try {
      const resp = await invoke<{ success: boolean; data?: SessionState; error?: string }>("desktop_get_state");
      if (resp.success && resp.data) {
        setSession(resp.data);
        setStreaming(Boolean(resp.data.isStreaming));
      }
    } catch (e) {
      setError(`get_state: ${String(e)}`);
    }
  }, []);

  const refreshCommands = useCallback(async () => {
    try {
      const resp = await invoke<{
        success: boolean;
        data?: { commands: SdkSlashCommand[] };
        error?: string;
      }>("desktop_get_commands");
      if (!resp.success) {
        setError(`get_commands: ${resp.error ?? "unknown"}`);
        return;
      }
      setSdkSlashCommands(toSlashCommandDefs(resp.data?.commands ?? []));
    } catch (e) {
      setError(`get_commands: ${String(e)}`);
    }
  }, []);

  const refreshModels = useCallback(async (): Promise<DesktopModel[]> => {
    try {
      const resp = await invoke<{
        success: boolean;
        data?: { models: DesktopModel[] };
        error?: string;
      }>("desktop_get_models");
      if (!resp.success) {
        setError(`get_models: ${resp.error ?? "unknown"}`);
        setAvailableModels([]);
        return [];
      }
      const models = resp.data?.models ?? [];
      setAvailableModels(models);
      return models;
    } catch (e) {
      setError(`get_models: ${String(e)}`);
      setAvailableModels([]);
      return [];
    }
  }, []);

  const selectModel = useCallback(async (modelRef: string) => {
    const ref = modelRef.trim();
    if (!ref) return;
    setError(null);
    const resp = await invoke<{ success: boolean; data?: { model: DesktopModel }; error?: string }>("desktop_set_model", {
      modelRef: ref,
    });
    if (!resp.success) {
      setError(`set_model: ${resp.error ?? "unknown"}`);
      return;
    }
    setModelPickerOpen(false);
    setModelPickerQuery("");
    await refreshState();
    await refreshModels();
    setMessages((prev) => [
      ...prev,
      {
        id: genId("a"),
        role: "assistant",
        parts: [{ kind: "text", text: `Model set to ${resp.data?.model.name ?? ref}.` }],
      },
    ]);
  }, [refreshModels, refreshState]);

  const refreshSlashCompletions = useCallback(async (command: string, argumentPrefix: string) => {
    try {
      const resp = await invoke<{
        success: boolean;
        data?: { completions: SlashCompletionItem[] };
        error?: string;
      }>("desktop_get_command_completions", { command: command.replace(/^\/+/, ""), argumentPrefix });
      if (!resp.success) {
        setSlashCompletions([]);
        setError(`get_command_completions: ${resp.error ?? "unknown"}`);
        return;
      }
      setSlashCompletions(resp.data?.completions ?? []);
      setSlashCompletionIndex(0);
    } catch (e) {
      setSlashCompletions([]);
      setError(`get_command_completions: ${String(e)}`);
    }
  }, []);

  const refreshPathCompletions = useCallback(async (prefix: string) => {
    if (!workspace) {
      setSlashCompletions([]);
      return;
    }
    try {
      const items = await invoke<SlashCompletionItem[]>("complete_path", { cwd: workspace, prefix });
      setSlashCompletions(items.map((item) => ({ ...item, kind: "path" })));
      setSlashCompletionIndex(0);
    } catch (e) {
      setSlashCompletions([]);
      setError(`complete_path: ${String(e)}`);
    }
  }, [workspace]);

  const updateVirtualRange = useCallback(() => {
    const el = scrollRef.current;
    const viewportHeight = el?.clientHeight ?? window.innerHeight;
    const scrollTop = el?.scrollTop ?? 0;
    const lower = Math.max(0, scrollTop - VIRTUAL_OVERSCAN_PX);
    const upper = scrollTop + viewportHeight + VIRTUAL_OVERSCAN_PX;
    const heights = messageHeightsRef.current;
    const currentMessages = messagesRef.current;

    let start = 0;
    let before = 0;
    while (start < currentMessages.length) {
      const message = currentMessages[start];
      if (!message) break;
      const height = heights.get(message.id) ?? estimateMessageHeight(message);
      if (before + height >= lower) break;
      before += height;
      start += 1;
    }

    let end = start;
    let consumed = before;
    while (end < currentMessages.length) {
      const message = currentMessages[end];
      if (!message) break;
      consumed += heights.get(message.id) ?? estimateMessageHeight(message);
      end += 1;
      if (consumed >= upper) break;
    }

    let after = 0;
    for (let index = end; index < currentMessages.length; index += 1) {
      const message = currentMessages[index];
      if (!message) continue;
      after += heights.get(message.id) ?? estimateMessageHeight(message);
    }

    setVirtualRange((prev) => (
      prev.start === start && prev.end === end && prev.before === before && prev.after === after
        ? prev
        : { start, end, before, after }
    ));
  }, []);

  const measureMessage = useCallback((id: string, node: HTMLDivElement | null) => {
    if (!node) return;
    const height = node.getBoundingClientRect().height;
    if (!Number.isFinite(height) || height <= 0) return;
    const previous = messageHeightsRef.current.get(id);
    if (previous !== undefined && Math.abs(previous - height) < 1) return;
    messageHeightsRef.current.set(id, height);
    window.requestAnimationFrame(updateVirtualRange);
  }, [updateVirtualRange]);

  useEffect(() => {
    const ids = new Set(messages.map((message) => message.id));
    for (const id of messageHeightsRef.current.keys()) {
      if (!ids.has(id)) messageHeightsRef.current.delete(id);
    }
    updateVirtualRange();
  }, [messages, updateVirtualRange]);

  useEffect(() => {
    const onResize = () => updateVirtualRange();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [updateVirtualRange]);

  const fetchMessagesPage = useCallback(async (cmd: { sessionPath?: string; offset?: number; limit?: number; fromEnd?: boolean; lazyOlder?: boolean; anchorId?: string; anchorEntryOffset?: number; before?: number; after?: number; beforeOffset?: boolean; restoreViewport?: boolean }) => {
    if (cmd.sessionPath) {
      return await invoke<MessagesPage>("read_session_messages_window", {
        sessionPath: cmd.sessionPath,
        offset: cmd.offset,
        limit: cmd.limit,
        fromEnd: cmd.fromEnd,
        anchorId: cmd.anchorId,
        anchorEntryOffset: cmd.anchorEntryOffset,
        before: cmd.before,
        after: cmd.after,
        beforeOffset: cmd.beforeOffset,
        restoreViewport: cmd.restoreViewport,
      });
    }
    const resp = await invoke<{ success: boolean; data?: MessagesPage; error?: string }>(
      "desktop_get_messages",
      { cmd },
    );
    if (!resp.success) throw new Error(resp.error ?? "unknown");
    return resp.data ?? { messages: [], offset: 0, total: 0 };
  }, []);

  const cancelHistoryLoad = useCallback(() => {
    historyLoadSeqRef.current += 1;
    historyLoadInFlightRef.current = null;
    setLoadingMessages(false);
    setHistoryLoadProgress(null);
    setOlderHistory((prev) => ({ ...prev, loading: false }));
    setNewerHistory((prev) => ({ ...prev, loading: false }));
  }, []);

  const scrollAnchorFor = useCallback((scrollTop: number): Pick<TabScrollState, "anchorId" | "anchorOffset" | "anchorEntryOffset"> => {
    const domAnchor = scrollRef.current ? domScrollAnchorFor(scrollRef.current) : undefined;
    if (domAnchor) return domAnchor;

    const heights = messageHeightsRef.current;
    let top = 0;
    for (const message of messagesRef.current) {
      const height = heights.get(message.id) ?? estimateMessageHeight(message);
      if (top + height >= scrollTop) {
        return { anchorId: message.id, anchorOffset: Math.max(0, scrollTop - top), anchorEntryOffset: message.entryOffset };
      }
      top += height;
    }
    const last = messagesRef.current.at(-1);
    return last ? { anchorId: last.id, anchorOffset: 0, anchorEntryOffset: last.entryOffset } : {};
  }, []);

  const captureTabScroll = useCallback((path: string | null | undefined) => {
    const el = scrollRef.current;
    if (!path || !el) return null;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    const state: TabScrollState = {
      followOutput: distanceFromBottom < 80,
      ...scrollAnchorFor(el.scrollTop),
    };
    tabScrollRef.current.set(path, state);
    return state;
  }, [scrollAnchorFor]);

  const saveTabViewport = useCallback((path: string | null | undefined, state?: TabScrollState | null) => {
    if (!path) return;
    const viewport = state ?? tabScrollRef.current.get(path);
    if (!viewport) return;
    void invoke("save_session_viewport", {
      sessionPath: path,
      followOutput: viewport.followOutput,
      anchorId: viewport.anchorId,
      anchorOffset: viewport.anchorOffset,
      anchorEntryOffset: viewport.anchorEntryOffset,
    }).catch((e) => setError(`save viewport: ${String(e)}`));
  }, []);

  const scheduleRestoreTabScroll = useCallback((path: string | null | undefined): boolean => {
    if (!path) return false;
    const saved = tabScrollRef.current.get(path);
    if (!saved) return false;
    restoreScrollNextRenderRef.current = { path, ...saved };
    followOutputRef.current = saved.followOutput;
    return true;
  }, []);

  const scheduleTabSwitchScrollRestore = useCallback((path: string | null | undefined): void => {
    if (!path) return;
    const saved = tabScrollRef.current.get(path);
    restoreScrollNextRenderRef.current = {
      path,
      followOutput: saved?.followOutput ?? false,
      ...(saved?.anchorId ? { anchorId: saved.anchorId, anchorOffset: saved.anchorOffset ?? 0, anchorEntryOffset: saved.anchorEntryOffset } : {}),
    };
    followOutputRef.current = saved?.followOutput ?? false;
    scrollToBottomNextRenderRef.current = false;
    setVirtualRange({ start: 0, end: 0, before: 0, after: 0 });
  }, []);

  const loadMessages = useCallback(async (path?: string) => {
    const loadPath = path ?? "__active__";
    if (historyLoadInFlightRef.current === loadPath) return;
    historyLoadInFlightRef.current = loadPath;
    const loadSeq = historyLoadSeqRef.current + 1;
    historyLoadSeqRef.current = loadSeq;
    setLoadingMessages(true);
    setHistoryLoadProgress({ loaded: 0, total: sessionMessageCountRef.current });
    setOlderHistory({ nextOffset: 0, hasExternalOlder: false, loading: false });
    setNewerHistory({ nextOffset: 0, hasNewer: false, loading: false });
    const isStaleLoad = () =>
      historyLoadSeqRef.current !== loadSeq || (path ? activeTabIdRef.current !== path : false);
    try {
      const saved = path ? tabScrollRef.current.get(path) : undefined;
      const first = await fetchMessagesPage(saved?.anchorEntryOffset !== undefined && !saved.followOutput && path
        ? { sessionPath: path, anchorId: saved.anchorId, anchorEntryOffset: saved.anchorEntryOffset, before: INITIAL_VIEWPORT_BEFORE, after: INITIAL_VIEWPORT_AFTER, limit: INITIAL_VIEWPORT_BEFORE + INITIAL_VIEWPORT_AFTER }
        : path
          ? { sessionPath: path, fromEnd: true, limit: INITIAL_MESSAGE_CHUNK, restoreViewport: true }
          : { fromEnd: true, limit: INITIAL_MESSAGE_CHUNK });
      if (isStaleLoad()) {
        if (historyLoadInFlightRef.current === loadPath) historyLoadInFlightRef.current = null;
        return;
      }

      let page = first;
      let next = toChatMessages(page.messages);
      let loadedHeadFallback = false;
      // Some pathological sessions end with hundreds of MB of non-display
      // entries (for example dcp-state snapshots). Do not walk backward through
      // all of that on initial paint. Show the first visible page immediately;
      // the user can then scroll forward lazily through the file windows.
      if (path && next.length === 0 && page.hasOlder) {
        page = await fetchMessagesPage({ sessionPath: path, offset: 0, limit: INITIAL_MESSAGE_CHUNK });
        if (isStaleLoad()) {
          if (historyLoadInFlightRef.current === loadPath) historyLoadInFlightRef.current = null;
          return;
        }
        next = toChatMessages(page.messages);
        loadedHeadFallback = true;
      }
      if (path && first.cursor) tabScrollRef.current.set(path, first.cursor);
      if (loadedHeadFallback) {
        followOutputRef.current = false;
        scrollToBottomNextRenderRef.current = false;
        restoreScrollNextRenderRef.current = null;
      } else if (!scheduleRestoreTabScroll(path)) {
        scrollToBottomNextRenderRef.current = true;
      }
      setMessages(next);
      if (path) tabMessagesRef.current.set(path, next);
      const startIndex = page.startIndex ?? page.offset;
      const endIndex = page.endIndex ?? (page.offset + page.messages.length);
      setOlderHistory({ nextOffset: startIndex, hasExternalOlder: Boolean(page.hasOlder), loading: false });
      setNewerHistory({ nextOffset: endIndex, hasNewer: Boolean(page.hasNewer), loading: false });
      setLoadingMessages(false);
      setHistoryLoadProgress(null);
      if (historyLoadInFlightRef.current === loadPath) historyLoadInFlightRef.current = null;
    } catch (e) {
      if (!isStaleLoad()) setError(`get_messages: ${String(e)}`);
      if (historyLoadSeqRef.current === loadSeq) {
        setLoadingMessages(false);
        setHistoryLoadProgress(null);
        setOlderHistory({ nextOffset: 0, hasExternalOlder: false, loading: false });
        setNewerHistory({ nextOffset: 0, hasNewer: false, loading: false });
      }
      if (historyLoadInFlightRef.current === loadPath) historyLoadInFlightRef.current = null;
    }
  }, [fetchMessagesPage, scheduleRestoreTabScroll]);

  const loadOlderMessages = useCallback(async () => {
    if ((olderHistory.nextOffset <= 0 && !olderHistory.hasExternalOlder) || olderHistory.loading || loadingMessages) return;
    const el = scrollRef.current;
    const prependAnchor = el ? scrollAnchorFor(el.scrollTop) : {};
    const loadSeq = historyLoadSeqRef.current;
    const path = activeTabIdRef.current;
    const isStaleLoad = () => historyLoadSeqRef.current !== loadSeq || activeTabIdRef.current !== path;
    const loadFromOffset = olderHistory.nextOffset;
    setOlderHistory((prev) => ({ ...prev, loading: true }));
    try {
      const offset = Math.max(0, loadFromOffset - BACKFILL_MESSAGE_CHUNK);
      const older = path
        ? await fetchMessagesPage({ sessionPath: path, offset: loadFromOffset, limit: BACKFILL_MESSAGE_CHUNK, beforeOffset: true })
        : loadFromOffset > 0
          ? await fetchMessagesPage({ offset, limit: loadFromOffset - offset })
          : await fetchMessagesPage({ offset: 0, limit: BACKFILL_MESSAGE_CHUNK, lazyOlder: true });
      if (isStaleLoad()) {
        setOlderHistory((prev) => ({ ...prev, loading: false }));
        return;
      }
      if (older.messages.length === 0) {
        setOlderHistory({
          nextOffset: older.startIndex ?? older.offset ?? 0,
          hasExternalOlder: Boolean(older.hasOlder),
          loading: false,
        });
        return;
      }
      const olderChatMessages = toChatMessages(older.messages);
      prependScrollAnchorRef.current = prependAnchor;
      setMessages((current) => {
        const next = [...olderChatMessages, ...current];
        if (path) tabMessagesRef.current.set(path, next);
        return next;
      });
      setOlderHistory({
        nextOffset: older.startIndex ?? (loadFromOffset > 0 ? older.offset : 0),
        hasExternalOlder: Boolean(older.hasOlder),
        loading: false,
      });
    } catch (e) {
      if (!isStaleLoad()) setError(`get_messages: ${String(e)}`);
      setOlderHistory((prev) => ({ ...prev, loading: false }));
    }
  }, [fetchMessagesPage, loadingMessages, olderHistory.hasExternalOlder, olderHistory.loading, olderHistory.nextOffset, scrollAnchorFor]);

  const loadNewerMessages = useCallback(async () => {
    if (!newerHistory.hasNewer || newerHistory.loading || loadingMessages) return;
    const loadSeq = historyLoadSeqRef.current;
    const path = activeTabIdRef.current;
    if (!path) return;
    const isStaleLoad = () => historyLoadSeqRef.current !== loadSeq || activeTabIdRef.current !== path;
    const loadFromOffset = newerHistory.nextOffset;
    setNewerHistory((prev) => ({ ...prev, loading: true }));
    try {
      const newer = await fetchMessagesPage({ sessionPath: path, offset: loadFromOffset, limit: BACKFILL_MESSAGE_CHUNK });
      if (isStaleLoad()) {
        setNewerHistory((prev) => ({ ...prev, loading: false }));
        return;
      }
      if (newer.messages.length === 0) {
        setNewerHistory({
          nextOffset: newer.endIndex ?? newer.offset ?? loadFromOffset,
          hasNewer: Boolean(newer.hasNewer),
          loading: false,
          gapBytes: Math.max(
            newerHistory.gapBytes ?? 0,
            Math.max(0, (newer.endIndex ?? newer.offset ?? loadFromOffset) - loadFromOffset),
          ),
        });
        return;
      }
      const newerChatMessages = toChatMessages(newer.messages);
      setMessages((current) => {
        const next = [...current, ...newerChatMessages];
        tabMessagesRef.current.set(path, next);
        return next;
      });
      setNewerHistory({
        nextOffset: newer.endIndex ?? (loadFromOffset + newer.messages.length),
        hasNewer: Boolean(newer.hasNewer),
        loading: false,
        gapBytes: 0,
      });
    } catch (e) {
      if (!isStaleLoad()) setError(`get_messages: ${String(e)}`);
      setNewerHistory((prev) => ({ ...prev, loading: false }));
    }
  }, [fetchMessagesPage, loadingMessages, newerHistory.hasNewer, newerHistory.loading, newerHistory.nextOffset]);

  const handleChatScroll = useCallback(() => {
    const el = scrollRef.current;
    let distanceFromBottom = Number.POSITIVE_INFINITY;
    if (el) {
      distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
      followOutputRef.current = distanceFromBottom < 80;
      const path = activeTabIdRef.current;
      if (suppressNextScrollCaptureRef.current) {
        suppressNextScrollCaptureRef.current = false;
      } else if (path) {
        tabScrollRef.current.set(path, {
          followOutput: followOutputRef.current,
          ...scrollAnchorFor(el.scrollTop),
        });
      }
    }
    updateVirtualRange();
    if (!el) return;
    if (el.scrollTop <= LOAD_OLDER_SCROLL_THRESHOLD_PX) void loadOlderMessages();
    if (distanceFromBottom <= LOAD_OLDER_SCROLL_THRESHOLD_PX) void loadNewerMessages();
  }, [loadNewerMessages, loadOlderMessages, scrollAnchorFor, updateVirtualRange]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el || loadingMessages || newerHistory.loading || !newerHistory.hasNewer || newerGapHeight > 0) return;
    const contentUnderfillsViewport = el.scrollHeight <= el.clientHeight + LOAD_OLDER_SCROLL_THRESHOLD_PX;
    const alreadyAtBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= LOAD_OLDER_SCROLL_THRESHOLD_PX;
    if (contentUnderfillsViewport || alreadyAtBottom) void loadNewerMessages();
  }, [messages, loadingMessages, loadNewerMessages, newerGapHeight, newerHistory.hasNewer, newerHistory.loading]);

  const restoreTabsForWorkspace = useCallback(async (cwd: string, currentSessionFile?: string) => {
    const persisted = await readPersistedTabs(cwd);
    const restoredTabs = persisted.openTabs;
    const tabs = uniqueStrings([
      ...restoredTabs,
      ...(currentSessionFile ? [currentSessionFile] : []),
    ]);
    const active = persisted.activeTabId && tabs.includes(persisted.activeTabId)
      ? persisted.activeTabId
      : currentSessionFile ?? tabs[0] ?? null;

    tabMessagesRef.current.clear();
    tabScrollRef.current = new Map(Object.entries(persisted.scroll ?? {}));
    hydratedTabsWorkspaceRef.current = cwd;
    setRestoredTabTitles(persisted.titles ?? {});
    setOpenTabs(tabs);
    activeTabIdRef.current = active;
    setActiveTabId(active);
    setMessages([]);

    if (active && active !== currentSessionFile) {
      const resp = await switchDesktopSession(cwd, active);
      if (!resp.success) {
        const fallback = currentSessionFile ?? null;
        const fallbackTabs = uniqueStrings([
          ...tabs.filter((p) => p !== active),
          ...(fallback ? [fallback] : []),
        ]);
        setError(`restore tab: ${resp.error ?? "switch_session failed"}`);
        setOpenTabs(fallbackTabs);
        activeTabIdRef.current = fallback;
        setActiveTabId(fallback);
        void refreshState();
        if (fallback) void loadMessages(fallback);
        return;
      }
    }

    if (active) suppressNextSessionSyncRef.current = active;
    void refreshState();
    void refreshCommands();
    void refreshSessions();
    if (active) void loadMessages(active);
  }, [loadMessages, refreshCommands, refreshSessions, refreshState]);

  const chooseFolder = useCallback(async (): Promise<string | null> => {
    try {
      const selected = await openDialog({
        directory: true,
        multiple: false,
        title: "Choose project folder",
      });
      if (typeof selected !== "string" || !selected) return null;
      setSwitchingWorkspace(true);
      setError(null);
      const resp = await invoke<{ success: boolean; data?: { cwd: string; sessionId: string; sessionFile?: string }; error?: string }>(
        "set_workspace",
        { path: selected },
      );
      if (!resp.success) {
        setError(resp.error ?? "set_workspace failed");
        return null;
      }
      const newCwd = resp.data?.cwd ?? selected;
      void writePersistedWorkspace(newCwd).catch((e) => setError(`save workspace: ${String(e)}`));
      appliedWorkspaceRef.current = newCwd;
      setWorkspace(newCwd);
      await restoreTabsForWorkspace(newCwd, resp.data?.sessionFile);
      return newCwd;
    } catch (e) {
      setError(`choose folder: ${String(e)}`);
      return null;
    } finally {
      setSwitchingWorkspace(false);
    }
  }, [restoreTabsForWorkspace]);

  // -- Mount: subscribe + load initial state + sessions ------------------

  useEffect(() => {
    if (subscribed.current) return;
    subscribed.current = true;

    const ch = new Channel<RpcEvent>();
    ch.onmessage = (ev) => handleEvent(ev);
    void invoke("rpc_subscribe", { onEvent: ch }).catch((e) =>
      setError(`subscribe failed: ${String(e)}`),
    );
    if (!workspace) void refreshState();
    void readPersistedWorkspace()
      .then((saved) => {
        if (saved && !appliedWorkspaceRef.current) setWorkspace((current) => current ?? saved);
      })
      .catch((e) => setError(`restore workspace: ${String(e)}`));
  }, [refreshState, workspace]);

  // If a workspace was previously chosen, re-apply it on startup so the
  // sidecar picks up the same cwd (otherwise the sidecar is bound to its
  // package directory and list_sessions returns the wrong sessions).
  useEffect(() => {
    if (!workspace) return;
    if (appliedWorkspaceRef.current === workspace) return;
    void invoke<{ success: boolean; data?: { sessionFile?: string }; error?: string }>("set_workspace", { path: workspace })
      .then(async (resp) => {
        if (!resp.success) {
          // Saved workspace is no longer accessible — drop it and let the
          // user re-pick.
          void writePersistedWorkspace(null).catch((e) => setError(`save workspace: ${String(e)}`));
          setWorkspace(null);
          setError(`workspace '${workspace}' unavailable: ${resp.error ?? "?"}`);
          return;
        }
        appliedWorkspaceRef.current = workspace;
        void restoreTabsForWorkspace(workspace, resp.data?.sessionFile);
      })
      .catch((e) => setError(`restore workspace: ${String(e)}`));
  }, [workspace, restoreTabsForWorkspace]);

  // Persist open tabs per workspace after that workspace has been hydrated
  // from localStorage. This guard avoids overwriting saved tabs with the
  // initial empty React state during startup.
  useEffect(() => {
    if (!workspace || hydratedTabsWorkspaceRef.current !== workspace) return;
    saveTabViewport(activeTabId, captureTabScroll(activeTabId));
    void writePersistedTabs(workspace, persistedTabsFor(openTabs, activeTabId, sessions, session, restoredTabTitles, tabScrollRef.current));
  }, [workspace, openTabs, activeTabId, sessions, session, restoredTabTitles, captureTabScroll, saveTabViewport]);

  // Persist the current virtual viewport before the webview is torn down so a
  // later /resume or app restart restores the same cursor position instead of
  // always jumping to the tail.
  useEffect(() => {
    const persistViewport = () => {
      if (!workspace || hydratedTabsWorkspaceRef.current !== workspace) return;
      saveTabViewport(activeTabIdRef.current, captureTabScroll(activeTabIdRef.current));
      void writePersistedTabs(workspace, persistedTabsFor(openTabs, activeTabIdRef.current, sessions, session, restoredTabTitles, tabScrollRef.current));
    };
    window.addEventListener("beforeunload", persistViewport);
    window.addEventListener("pagehide", persistViewport);
    return () => {
      window.removeEventListener("beforeunload", persistViewport);
      window.removeEventListener("pagehide", persistViewport);
    };
  }, [workspace, openTabs, sessions, session, restoredTabTitles, captureTabScroll, saveTabViewport]);

  // Refresh sessions whenever workspace changes (or on initial mount).
  useEffect(() => {
    if (workspace) void refreshSessions();
  }, [workspace, refreshSessions]);

  // Sync tab state when the sidecar reports a real session change. Do not run
  // this as a reaction to `activeTabId`: tab clicks are optimistic and must not
  // be rolled back to the old sidecar session while switch_session is pending.
  useEffect(() => {
    const path = session.sessionFile;
    if (!path) return;
    if (suppressNextSessionSyncRef.current === path) {
      suppressNextSessionSyncRef.current = null;
      return;
    }
    const pendingSwitch = pendingSessionSwitchRef.current;
    const active = activeTabIdRef.current;
    if (pendingSwitch && active === pendingSwitch && path !== pendingSwitch) {
      return;
    }
    if (pendingSwitch === path) {
      pendingSessionSwitchRef.current = null;
    }
    if (active && active !== path) {
      // Old tab's messages are already in tabMessagesRef via switchSession,
      // but events since the last switch may have updated them — refresh.
      tabMessagesRef.current.set(active, messagesRef.current);
    }
    setOpenTabs((tabs) => (tabs.includes(path) ? tabs : [...tabs, path]));
    if (active !== path) {
      activeTabIdRef.current = path;
      setActiveTabId(path);
    }
    if (!tabMessagesRef.current.has(path) && messagesRef.current.length === 0) {
      void loadMessages(path);
    }
  }, [session.sessionFile, loadMessages]);

  // Periodic refresh of stats (contextUsage, messageCount) for the status bar.
  // Cheap; sidecar just reads cached values. Skip while no session is active.
  useEffect(() => {
    if (!session.sessionFile) return;
    const t = window.setInterval(() => {
      void refreshState();
    }, 4000);
    return () => window.clearInterval(t);
  }, [session.sessionFile, refreshState]);

  // -- Event handler -----------------------------------------------------

  const respondToExtensionDialog = useCallback(async (request: ExtensionUIRequest, payload: Record<string, unknown>) => {
    if (!request.id) return;
    try {
      const resp = await invoke<{ success: boolean; error?: string }>("desktop_extension_ui_response", {
        requestId: request.id,
        payload,
      });
      if (!resp.success) setError(`extension_ui_response: ${resp.error ?? "unknown"}`);
    } catch (e) {
      setError(`extension_ui_response: ${String(e)}`);
    }
  }, []);

  const handleExtensionUIRequest = useCallback((ev: RpcEvent) => {
    const request = ev as ExtensionUIRequest;
    switch (request.method) {
      case "select":
      case "confirm":
      case "input":
      case "editor":
        setExtensionDialog(request);
        setExtensionDialogValue(request.prefill ?? "");
        break;
      case "notify": {
        const toast = {
          id: request.id ?? genId("toast"),
          message: request.message ?? "Extension notification",
          type: request.notifyType ?? "info",
        } satisfies ExtensionToast;
        setExtensionToasts((prev) => [...prev, toast]);
        window.setTimeout(() => {
          setExtensionToasts((prev) => prev.filter((item) => item.id !== toast.id));
        }, 5000);
        break;
      }
      case "setStatus":
        if (!request.statusKey) break;
        setExtensionStatuses((prev) => {
          const next = { ...prev };
          if (request.statusText) next[request.statusKey!] = request.statusText;
          else delete next[request.statusKey!];
          return next;
        });
        break;
      case "setWidget":
        if (!request.widgetKey) break;
        setExtensionWidgets((prev) => {
          const next = { ...prev };
          if (Array.isArray(request.widgetLines)) {
            next[request.widgetKey!] = {
              key: request.widgetKey!,
              lines: request.widgetLines,
              placement: request.widgetPlacement ?? "aboveEditor",
            };
          } else {
            delete next[request.widgetKey!];
          }
          return next;
        });
        break;
      case "setWidgetComponent":
        if (!request.widgetKey) break;
        setExtensionWidgets((prev) => {
          const next = { ...prev };
          if (request.active === false) {
            delete next[request.widgetKey!];
          } else {
            next[request.widgetKey!] = {
              key: request.widgetKey!,
              placement: request.widgetPlacement ?? "aboveEditor",
              degradedComponent: true,
              lines: [
                "This extension supplied a TUI component widget.",
                "Pix Desktop cannot render extension component factories yet, so this degraded placeholder keeps the request visible instead of silently dropping it.",
              ],
            };
          }
          return next;
        });
        break;
      case "setWorkingMessage":
        setExtensionChrome((prev) => ({ ...prev, workingMessage: request.workingMessage || undefined }));
        break;
      case "setWorkingVisible":
        setExtensionChrome((prev) => ({ ...prev, workingVisible: request.workingVisible }));
        break;
      case "setWorkingIndicator":
        setExtensionChrome((prev) => ({ ...prev, workingIndicatorFrames: request.workingIndicatorFrames }));
        break;
      case "setHiddenThinkingLabel":
        setExtensionChrome((prev) => ({ ...prev, hiddenThinkingLabel: request.hiddenThinkingLabel || undefined }));
        break;
      case "setHeader":
        setExtensionChrome((prev) => ({ ...prev, headerActive: request.active === true }));
        break;
      case "setFooter":
        setExtensionChrome((prev) => ({ ...prev, footerActive: request.active === true }));
        break;
      case "custom":
        setExtensionChrome((prev) => ({ ...prev, customUiRequested: true }));
        {
          const toast = {
            id: request.id ?? genId("toast"),
            type: "warning",
            message: request.overlay
              ? "Extension requested a custom overlay component; Pix Desktop degrades it to an undefined result."
              : "Extension requested a custom component; Pix Desktop degrades it to an undefined result.",
          } satisfies ExtensionToast;
          setExtensionToasts((prev) => [...prev, toast]);
          window.setTimeout(() => {
            setExtensionToasts((prev) => prev.filter((item) => item.id !== toast.id));
          }, 5000);
        }
        break;
      case "setEditorComponent":
        setExtensionChrome((prev) => ({ ...prev, editorComponentActive: request.active === true }));
        break;
      case "addAutocompleteProvider":
        setExtensionChrome((prev) => ({ ...prev, autocompleteProviderActive: request.active === true }));
        break;
      case "setTitle":
        if (request.title) document.title = request.title;
        break;
      case "set_editor_text":
        setInput(request.text ?? "");
        break;
      default:
        setError(`Unsupported extension UI request: ${request.method ?? "unknown"}`);
    }
  }, []);

  const handleEvent = useCallback(
    (ev: RpcEvent) => {
      switch (ev.type) {
        case "extension_ui_request":
          handleExtensionUIRequest(ev);
          break;
        case "agent_start":
          setStreaming(true);
          setSession((s) => ({ ...s, isStreaming: true }));
          break;
        case "agent_end":
          setStreaming(false);
          setSession((s) => ({ ...s, isStreaming: false }));
          break;
        case "session_start":
        case "session_info_changed":
          // Session may have been renamed or replaced; refresh both views.
          void refreshState();
          void refreshSessions();
          void refreshCommands();
          break;
        case "message_start":
          if (ev.message?.role === "assistant") {
            cancelHistoryLoad();
            setMessages((prev) => [...prev, { id: genId("a"), role: "assistant", parts: [] }]);
          }
          break;
        case "message_update": {
          const d = ev.assistantMessageEvent;
          if (d?.type === "text_delta" && typeof d.delta === "string") {
            cancelHistoryLoad();
            const delta = d.delta;
            setMessages((prev) => updateLastAssistant(prev, (parts) => appendText(parts, delta)));
          }
          break;
        }
        case "tool_execution_start":
          if (!ev.toolCallId || !ev.toolName) break;
          cancelHistoryLoad();
          setMessages((prev) =>
            updateLastAssistant(prev, (parts) => [
              ...parts,
              {
                kind: "tool",
                toolCallId: ev.toolCallId!,
                name: ev.toolName!,
                args: ev.args,
                status: "running",
              },
            ]),
          );
          break;
        case "tool_execution_end":
          if (!ev.toolCallId) break;
          cancelHistoryLoad();
          setMessages((prev) =>
            updateLastAssistant(prev, (parts) =>
              parts.map((p) =>
                p.kind === "tool" && p.toolCallId === ev.toolCallId
                  ? { ...p, status: ev.isError ? "error" : "done", result: ev.result }
                  : p,
              ),
            ),
          );
          break;
        case "extension_error":
          setError(`[${ev.event}] ${ev.error}`);
          break;
      }
    },
    [cancelHistoryLoad, handleExtensionUIRequest, refreshCommands, refreshState, refreshSessions],
  );

  // Follow opencode's shape: session sync renders one stable message snapshot
  // and scrolls to bottom once. Older history prepends preserve the viewport
  // anchor, so loading a long session does not animate through intermediate
  // history chunks or jump after the first tail render.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const prependAnchor = prependScrollAnchorRef.current;
    if (prependAnchor) {
      prependScrollAnchorRef.current = null;
      const targetScrollTop = scrollTopForAnchor(el, messages, messageHeightsRef.current, prependAnchor.anchorId, prependAnchor.anchorOffset);
      if (targetScrollTop !== undefined) {
        suppressNextScrollCaptureRef.current = true;
        el.scrollTop = Math.min(targetScrollTop, Math.max(0, el.scrollHeight - el.clientHeight));
        updateVirtualRange();
      }
      return;
    }
    const restore = restoreScrollNextRenderRef.current;
    if (restore && activeTabIdRef.current === restore.path) {
      restoreScrollNextRenderRef.current = null;
      followOutputRef.current = restore.followOutput;
      suppressNextScrollCaptureRef.current = true;
      const targetScrollTop = restore.followOutput
        ? el.scrollHeight
        : scrollTopForAnchor(el, messages, messageHeightsRef.current, restore.anchorId, restore.anchorOffset) ?? 0;
      el.scrollTop = Math.min(targetScrollTop, Math.max(0, el.scrollHeight - el.clientHeight));
      updateVirtualRange();
      return;
    }
    if (scrollToBottomNextRenderRef.current || followOutputRef.current) {
      scrollToBottomNextRenderRef.current = false;
      el.scrollTop = el.scrollHeight;
    }
    updateVirtualRange();
  }, [messages, updateVirtualRange]);

  // -- Actions -----------------------------------------------------------

  const executeSlashCommand = useCallback(async (raw: string) => {
    const trimmed = raw.trim();
    const command = trimmed.split(/\s+/, 1)[0]?.toLowerCase();
    const args = trimmed.slice((command ?? "").length).trim();
    setError(null);
    setInput("");
    setSlashIndex(0);
    cancelHistoryLoad();

    switch (command) {
      case "/help": {
        const lines = BASE_SLASH_COMMANDS.map((cmd) => `${cmd.name} — ${cmd.description}`);
        setMessages((prev) => [
          ...prev,
          { id: genId("a"), role: "assistant", parts: [{ kind: "text", text: lines.join("\n") }] },
        ]);
        return;
      }
      case "/model": {
        if (streaming) {
          setError("Cannot switch models while the agent is streaming. Stop the run first.");
          return;
        }
        if (args) {
          await selectModel(args);
          return;
        }
        await refreshModels();
        setModelPickerOpen(true);
        setModelPickerQuery("");
        return;
      }
      case "/compact": {
        if (streaming) {
          setError("Cannot compact while the agent is streaming. Stop the run first.");
          return;
        }
        setMessages((prev) => [
          ...prev,
          { id: genId("u"), role: "user", text: trimmed },
          { id: genId("a"), role: "assistant", parts: [{ kind: "text", text: "Compacting session context…" }] },
        ]);
        const resp = await invoke<{ success: boolean; error?: string }>("desktop_compact", {
          instructions: args || undefined,
        });
        if (!resp.success) {
          setError(`compact: ${resp.error ?? "unknown"}`);
          return;
        }
        setMessages((prev) => [
          ...prev.slice(0, -1),
          { id: genId("a"), role: "assistant", parts: [{ kind: "text", text: "Compaction complete." }] },
        ]);
        await refreshState();
        if (activeTabId) await loadMessages(activeTabId);
        return;
      }
      case "/undo": {
        if (streaming) {
          setError("Cannot undo while the agent is streaming. Stop the run first.");
          return;
        }
        const resp = await invoke<{
          success: boolean;
          data?: { editorText?: string; cancelled?: boolean; target?: { text?: string } };
          error?: string;
        }>("desktop_undo_last_turn");
        if (!resp.success) {
          setError(`undo: ${resp.error ?? "unknown"}`);
          return;
        }
        if (resp.data?.editorText) setInput(resp.data.editorText);
        await refreshState();
        if (activeTabId) await loadMessages(activeTabId);
        setMessages((prev) => [
          ...prev,
          {
            id: genId("a"),
            role: "assistant",
            parts: [{ kind: "text", text: resp.data?.cancelled ? "Undo cancelled." : "Navigated back to the last user turn." }],
          },
        ]);
        return;
      }
      case "/new": {
        if (streaming) {
          setError("Cannot create a new session while the agent is streaming. Stop the run first.");
          return;
        }
        setMessages([]);
        const resp = await invoke<{ success: boolean; error?: string }>("desktop_new_session");
        if (!resp.success) setError(resp.error ?? "new_session failed");
        await refreshState();
        return;
      }
      case "/clear":
        setMessages([]);
        if (activeTabId) tabMessagesRef.current.set(activeTabId, []);
        return;
      case "/refresh":
        await Promise.all([refreshState(), refreshSessions(), refreshCommands()]);
        return;
      case "/abort":
        await invoke("desktop_abort");
        return;
      default:
        if (sdkSlashCommands.some((cmd) => cmd.name.toLowerCase() === command)) {
          setMessages((prev) => [...prev, { id: genId("u"), role: "user", text: trimmed }]);
          const resp = await invoke<{ success: boolean; error?: string }>("desktop_prompt", { message: trimmed });
          if (!resp.success) setError(resp.error ?? "slash command rejected");
          return;
        }
        setError(`Unknown slash command: ${command ?? raw}`);
    }
  }, [activeTabId, cancelHistoryLoad, loadMessages, refreshCommands, refreshModels, refreshSessions, refreshState, sdkSlashCommands, selectModel, streaming]);

  const executeShellCommand = useCallback(async (raw: string) => {
    const command = raw.replace(/^!+/, "").trim();
    setError(null);
    setInput("");
    cancelHistoryLoad();
    if (!workspace) {
      setError("Choose a workspace before running shell commands.");
      return;
    }
    if (!command) {
      setError("Shell command is empty.");
      return;
    }
    const toolCallId = genId("shell");
    setMessages((prev) => [
      ...prev,
      { id: genId("u"), role: "user", text: `!${command}` },
      {
        id: genId("a"),
        role: "assistant",
        parts: [{ kind: "tool", toolCallId, name: "shell", args: { command, cwd: workspace }, status: "running" }],
      },
    ]);
    try {
      const result = await invoke<ShellRunResult>("run_shell", { cwd: workspace, command });
      setMessages((prev) =>
        updateLastTool(prev, toolCallId, {
          status: result.code === 0 && !result.timed_out ? "done" : "error",
          result,
        }),
      );
    } catch (e) {
      setMessages((prev) =>
        updateLastTool(prev, toolCallId, {
          status: "error",
          result: { stderr: String(e), stdout: "", code: null, signal: null, timed_out: false } satisfies ShellRunResult,
        }),
      );
    }
  }, [cancelHistoryLoad, workspace]);

  const openRawShell = useCallback((raw: string) => {
    const command = raw.replace(/^!!/, "").trim();
    setError(null);
    setInput("");
    cancelHistoryLoad();
    if (!workspace) {
      setError("Choose a workspace before opening a raw shell.");
      return;
    }
    setRawTerminal({ key: Date.now(), command: command || undefined });
  }, [cancelHistoryLoad, workspace]);

  const send = useCallback(async () => {
    const text = input.trim();
    const imageAttachments = attachments;
    if ((!text && imageAttachments.length === 0) || streaming) return;
    if (imageAttachments.length === 0 && text.startsWith("!!")) {
      openRawShell(text);
      return;
    }
    if (imageAttachments.length === 0 && text.startsWith("!")) {
      await executeShellCommand(text);
      return;
    }
    if (imageAttachments.length === 0 && text.startsWith("/")) {
      await executeSlashCommand(text);
      return;
    }
    setError(null);
    setInput("");
    setAttachments([]);
    cancelHistoryLoad();
    const promptText = text || "Attached image(s).";
    setMessages((prev) => [...prev, { id: genId("u"), role: "user", text: promptText, attachments: imageAttachments }]);
    try {
      const resp = await invoke<{ success: boolean; error?: string }>("desktop_prompt", {
        message: promptText,
        images: imageAttachments.map(({ data, mimeType }) => ({ type: "image", data, mimeType })),
      });
      if (!resp.success) setError(resp.error ?? "prompt rejected");
    } catch (e) {
      setError(String(e));
    }
  }, [attachments, cancelHistoryLoad, executeShellCommand, executeSlashCommand, input, openRawShell, streaming]);

  const abort = useCallback(async () => {
    try {
      await invoke("desktop_abort");
    } catch (e) {
      setError(String(e));
    }
  }, []);

  const newSession = useCallback(async () => {
    if (streaming) return;
    setError(null);
    cancelHistoryLoad();
    // Note: actual new sessionFile will come back via the session_start event,
    // which triggers the openTabs/activeTabId sync effect below.
    setMessages([]);
    try {
      const resp = await invoke<{ success: boolean; error?: string }>("desktop_new_session");
      if (!resp.success) setError(resp.error ?? "new_session failed");
      await refreshState();
    } catch (e) {
      setError(String(e));
    }
  }, [cancelHistoryLoad, refreshState, streaming]);

  const switchSession = useCallback(async (path: string) => {
    if (path === activeTabId) return;
    if (streaming && path !== activeTabId) {
      setError("Cannot switch sessions while the agent is streaming. Stop the run first.");
      return;
    }
    setError(null);
    saveTabViewport(activeTabId, captureTabScroll(activeTabId));
    cancelHistoryLoad();
    setVirtualRange({ start: 0, end: 0, before: 0, after: 0 });
    // Cache current messages under the previous active tab so switching back restores them.
    const prev = activeTabId;
    if (prev && prev !== path) {
      const previousMessages = messagesRef.current;
      if (previousMessages.length > 0) tabMessagesRef.current.set(prev, previousMessages);
      else tabMessagesRef.current.delete(prev);
    }
    const nextTabs = workspace
      ? await mutatePersistedTabs(workspace, "activate_desktop_tab", path).catch(() => null)
      : null;
    setOpenTabs(nextTabs?.openTabs ?? ((tabs) => (tabs.includes(path) ? tabs : [...tabs, path])));
    activeTabIdRef.current = path;
    setActiveTabId(path);
    pendingSessionSwitchRef.current = path;
    const cached = tabMessagesRef.current.get(path);
    const hasCachedMessages = (cached?.length ?? 0) > 0;
    if (cached) {
      scheduleTabSwitchScrollRestore(path);
    }
    setMessages(cached ?? []);
    if (!hasCachedMessages) {
      setLoadingMessages(true);
      setHistoryLoadProgress(null);
    }
    try {
      const resp = workspace
        ? await switchDesktopSession(workspace, path)
        : await invoke<{ success: boolean; error?: string }>("desktop_switch_session", { sessionPath: path });
      if (!resp.success) {
        if (pendingSessionSwitchRef.current === path) pendingSessionSwitchRef.current = null;
        if (prev && prev !== path) {
          activeTabIdRef.current = prev;
          setActiveTabId(prev);
          scheduleTabSwitchScrollRestore(prev);
          setMessages(tabMessagesRef.current.get(prev) ?? messagesRef.current);
        }
        setLoadingMessages(false);
        setHistoryLoadProgress(null);
        setError(resp.error ?? "switch_session failed");
        return;
      }
      if (activeTabIdRef.current !== path) return;
      suppressNextSessionSyncRef.current = path;
      await refreshState();
      if (activeTabIdRef.current !== path) return;
      if (!hasCachedMessages) void loadMessages(path);
    } catch (e) {
      if (pendingSessionSwitchRef.current === path) pendingSessionSwitchRef.current = null;
      if (prev && prev !== path) {
        activeTabIdRef.current = prev;
        setActiveTabId(prev);
        scheduleTabSwitchScrollRestore(prev);
        setMessages(tabMessagesRef.current.get(prev) ?? messagesRef.current);
      }
      setLoadingMessages(false);
      setHistoryLoadProgress(null);
      setError(String(e));
    }
  }, [activeTabId, cancelHistoryLoad, captureTabScroll, loadMessages, refreshState, scheduleTabSwitchScrollRestore, saveTabViewport, streaming, workspace]);

  const closeTab = useCallback(
    async (path: string) => {
      if (streaming) {
        setError("Cannot close or switch tabs while the agent is streaming. Stop the run first.");
        return;
      }
      // Drop the closed tab; forget its cached messages.
      const nextTabs = workspace
        ? await mutatePersistedTabs(workspace, "close_desktop_tab", path).catch(() => null)
        : null;
      const next = nextTabs?.openTabs ?? openTabs.filter((p) => p !== path);
      tabMessagesRef.current.delete(path);
      tabScrollRef.current.delete(path);
      cancelHistoryLoad();
      setOpenTabs(next);
      setVirtualRange({ start: 0, end: 0, before: 0, after: 0 });
      // If we closed the active tab, switch to the next remaining one (or clear).
      if (activeTabId === path) {
        const newActive = next[next.length - 1] ?? null;
        activeTabIdRef.current = newActive;
        setActiveTabId(newActive);
        if (newActive) {
          pendingSessionSwitchRef.current = newActive;
          const cached = tabMessagesRef.current.get(newActive);
          const hasCachedMessages = (cached?.length ?? 0) > 0;
          if (cached) {
            scheduleTabSwitchScrollRestore(newActive);
          }
          setMessages(cached ?? []);
          if (!hasCachedMessages) {
            setLoadingMessages(true);
            setHistoryLoadProgress(null);
          }
          try {
            const resp = workspace
              ? await switchDesktopSession(workspace, newActive)
              : await invoke<{ success: boolean; error?: string }>("desktop_switch_session", { sessionPath: newActive });
            if (!resp.success) throw new Error(resp.error ?? "switch_session failed");
            if (activeTabIdRef.current !== newActive) return;
            suppressNextSessionSyncRef.current = newActive;
            await refreshState();
            if (activeTabIdRef.current !== newActive) return;
            if (!hasCachedMessages) void loadMessages(newActive);
          } catch (e) {
            if (pendingSessionSwitchRef.current === newActive) pendingSessionSwitchRef.current = null;
            setLoadingMessages(false);
            setHistoryLoadProgress(null);
            setError(String(e));
          }
        } else {
          pendingSessionSwitchRef.current = null;
          setMessages([]);
          setLoadingMessages(false);
          setHistoryLoadProgress(null);
        }
      }
    },
    [openTabs, activeTabId, cancelHistoryLoad, loadMessages, refreshState, scheduleTabSwitchScrollRestore, streaming, workspace],
  );

  const composerCompletionTarget = useMemo(() => parseComposerCompletionTarget(input), [input]);
  const slashInput = parseSlashInput(input);
  const slashQuery = slashInput && slashInput.argumentPrefix === null
    ? slashInput.query.toLowerCase()
    : null;
  const showSlashCompletions = Boolean(composerCompletionTarget && slashCompletions.length > 0);
  const slashCommands = mergeSlashCommands([...BASE_SLASH_COMMANDS, ...sdkSlashCommands]).map((cmd) => ({
    ...cmd,
    disabled:
      (cmd.name === "/new" && streaming) ||
      (cmd.name === "/model" && streaming) ||
      (cmd.name === "/compact" && streaming) ||
      (cmd.name === "/undo" && streaming) ||
      (cmd.name === "/abort" && !streaming),
  }));
  const slashMatches = slashQuery === null
    ? []
    : slashCommands.filter((cmd) => {
      const needle = `${cmd.name} ${cmd.description}`.toLowerCase();
      return needle.includes(slashQuery);
    });

  useEffect(() => {
    setSlashIndex((idx) => Math.min(idx, Math.max(slashMatches.length - 1, 0)));
  }, [slashMatches.length]);

  useEffect(() => {
    if (!composerCompletionTarget) {
      setSlashCompletions([]);
      setSlashCompletionIndex(0);
      return;
    }
    if (composerCompletionTarget.kind === "path") {
      const timer = window.setTimeout(() => {
        void refreshPathCompletions(composerCompletionTarget.prefix);
      }, 120);
      return () => window.clearTimeout(timer);
    }
    if (composerCompletionTarget.command.toLowerCase() === "model") {
      const prefix = composerCompletionTarget.prefix.toLowerCase();
      const timer = window.setTimeout(() => {
        void refreshModels().then((models) => {
          const completions = models
            .filter((model) => `${model.ref} ${model.name}`.toLowerCase().includes(prefix))
            .slice(0, 20)
            .map((model) => ({
              label: model.name,
              value: model.ref,
              description: `${model.provider}/${model.id}${model.current ? " · current" : ""}`,
              kind: "model" as const,
            }));
          setSlashCompletions(completions);
          setSlashCompletionIndex(0);
        });
      }, 120);
      return () => window.clearTimeout(timer);
    }
    const discovered = sdkSlashCommands.find((cmd) => cmd.name.replace(/^\/+/, "").toLowerCase() === composerCompletionTarget.command.toLowerCase());
    if (discovered?.source !== "extension") {
      const timer = window.setTimeout(() => {
        void refreshPathCompletions(composerCompletionTarget.prefix);
      }, 120);
      return () => window.clearTimeout(timer);
    }
    const command = composerCompletionTarget.command;
    const prefix = composerCompletionTarget.prefix;
    const timer = window.setTimeout(async () => {
      await refreshSlashCompletions(command, prefix);
      // If the extension has no argument suggestions, fall back to scoped path
      // completions so generic slash arguments still have useful autocomplete.
      const likelyPath = prefix.includes("/") || prefix.includes("\\") || prefix.startsWith(".");
      if (likelyPath) {
        void refreshPathCompletions(prefix);
      }
    }, 120);
    return () => window.clearTimeout(timer);
  }, [composerCompletionTarget, refreshModels, refreshPathCompletions, refreshSlashCompletions, sdkSlashCommands]);

  useEffect(() => {
    if (composerCompletionTarget?.kind !== "slash-arg" || composerCompletionTarget.command.toLowerCase() === "model") {
      return;
    }
    if (slashCompletions.length > 0 || !looksLikePathPrefix(composerCompletionTarget.prefix)) return;
    const timer = window.setTimeout(() => {
      void refreshPathCompletions(composerCompletionTarget.prefix);
    }, 180);
    return () => window.clearTimeout(timer);
  }, [composerCompletionTarget, refreshPathCompletions, slashCompletions.length]);

  useEffect(() => {
    setSlashCompletionIndex((idx) => Math.min(idx, Math.max(slashCompletions.length - 1, 0)));
  }, [slashCompletions.length]);

  const applySlashCompletion = useCallback((item: SlashCompletionItem) => {
    const target = composerCompletionTarget ?? parseComposerCompletionTarget(input);
    if (!target) return;
    if (target.kind === "path") {
      const suffix = item.value.endsWith("/") ? "" : " ";
      const replacement = target.trigger === "mention" ? `@${item.value}${suffix}` : `${item.value}${suffix}`;
      setInput(`${input.slice(0, target.replaceStart)}${replacement}${input.slice(target.replaceEnd)}`);
    } else {
      setInput(`/${target.command} ${item.value}${item.value.endsWith(" ") ? "" : " "}`);
    }
    setSlashCompletionIndex(0);
  }, [composerCompletionTarget, input]);

  const widgetsAboveEditor = Object.values(extensionWidgets).filter((widget) => widget.placement !== "belowEditor");
  const widgetsBelowEditor = Object.values(extensionWidgets).filter((widget) => widget.placement === "belowEditor");
  const extensionStatusEntries = Object.entries(extensionStatuses);
  const extensionChromeActive = Boolean(
    extensionChrome.workingMessage ||
    extensionChrome.workingVisible !== undefined ||
    extensionChrome.workingIndicatorFrames ||
    extensionChrome.hiddenThinkingLabel ||
    extensionChrome.headerActive ||
    extensionChrome.footerActive ||
    extensionChrome.customUiRequested ||
    extensionChrome.editorComponentActive ||
    extensionChrome.autocompleteProviderActive,
  );
  const modelPickerMatches = availableModels.filter((model) => {
    const query = modelPickerQuery.trim().toLowerCase();
    if (!query) return true;
    return `${model.ref} ${model.name}`.toLowerCase().includes(query);
  });

  const closeExtensionDialog = useCallback((payload: Record<string, unknown>) => {
    const request = extensionDialog;
    if (!request) return;
    setExtensionDialog(null);
    setExtensionDialogValue("");
    void respondToExtensionDialog(request, payload);
  }, [extensionDialog, respondToExtensionDialog]);

  // -- Render ------------------------------------------------------------

  if (!workspace) {
    return (
      <div className="app app--picker">
        <div className="picker">
          <div className="picker__icon">
            <FolderOpen size={36} />
          </div>
          <h1 className="picker__title">Choose a project folder</h1>
          <p className="picker__hint">
            Pix Desktop scopes sessions to the folder you pick, just like running
            <code> pix</code> from that directory.
          </p>
          <button
            className="picker__btn"
            onClick={() => void chooseFolder()}
            disabled={switchingWorkspace}
          >
            <FolderOpen size={16} />
            {switchingWorkspace ? "Opening…" : "Choose folder"}
          </button>
          {error && (
            <div className="chat__error">
              <AlertCircle size={14} />
              <code>{error}</code>
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="app">
      <main className="chat">
        <div className="topbar" onMouseDown={handleTopbarMouseDown}>
          <div className="topbar__title">
            <button
              type="button"
              className="topbar__project"
              data-no-window-drag
              onClick={() => void chooseFolder()}
              disabled={switchingWorkspace || streaming}
              title="Change folder"
            >
              {workspaceTitle}
            </button>
            {sessionTitle && <span className="topbar__separator"> / </span>}
            {sessionTitle && <span className="topbar__session">{sessionTitle}</span>}
          </div>
          <div className="topbar__spacer" />
        </div>
        {openTabs.length > 0 && (
          <div className="tabsbar" role="tablist" aria-label="Open sessions">
            <div className="tabsbar__scroll">
              {openTabs.map((p) => (
                <button
                  key={p}
                  role="tab"
                  aria-selected={p === activeTabId}
                  className={`tabsbar__tab ${p === activeTabId ? "tabsbar__tab--active" : ""}`}
                  onClick={() => void switchSession(p)}
                  disabled={streaming && p !== activeTabId}
                  title={p}
                >
                  <span className="tabsbar__tab-label">
                    {sessionLabelFor(p, sessions, session, restoredTabTitles)}
                  </span>
                  <span
                    className="tabsbar__tab-close"
                    role="button"
                    tabIndex={-1}
                    aria-label="Close tab"
                    onClick={(e) => {
                      e.stopPropagation();
                      if (streaming) return;
                      void closeTab(p);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        e.stopPropagation();
                        void closeTab(p);
                      }
                    }}
                  >
                    <X size={11} />
                  </span>
                </button>
              ))}
            </div>
            <button
              className="tabsbar__new"
              onClick={newSession}
              disabled={streaming}
              title="New session"
              aria-label="New session"
            >
              <Plus size={13} />
            </button>
          </div>
        )}

        <div
          key={activeTabId ?? "no-session"}
          className="chat__body"
          ref={scrollRef}
          onScroll={handleChatScroll}
        >
          {olderHistory.loading && (
            <div className="chat__history-loading">
              Loading older history…
            </div>
          )}
          {loadingMessages && historyLoadProgress && historyLoadProgress.loaded > 0 && !historyLoadProgress.complete && (
            <div className="chat__history-loading">
              Loaded latest {historyLoadProgress.loaded} messages. Backfilling older history…
            </div>
          )}
          {messages.length === 0 ? (
            <div className="chat__empty">
              {loadingMessages ? <RefreshCw size={28} className="spinning" /> : <Sparkles size={28} />}
              <p>{loadingMessages ? "Loading session messages…" : "Send a message to start a conversation."}</p>
              {loadingMessages ? (
                <p className="chat__empty-hint">
                  The tab is already active. Content is loading in the background.
                </p>
              ) : null}
            </div>
          ) : (
            <>
              {renderedMessages.before > 0 && <div style={{ height: renderedMessages.before }} aria-hidden="true" />}
              {renderedMessages.messages.map((m) => (
                <MessageView key={m.id} message={m} measureRef={measureMessage} />
              ))}
              {renderedMessages.after > 0 && <div style={{ height: renderedMessages.after }} aria-hidden="true" />}
              {newerGapHeight > 0 && (
                <button
                  type="button"
                  className="chat__history-gap"
                  style={{ minHeight: newerGapHeight }}
                  onClick={() => void loadNewerMessages()}
                  disabled={newerHistory.loading}
                >
                  {newerHistory.loading ? "Loading next session window…" : "Skip non-display session gap"}
                </button>
              )}
            </>
          )}
          {error && (
            <div className="chat__error">
              <AlertCircle size={14} />
              <code>{error}</code>
            </div>
          )}
        </div>

        {widgetsAboveEditor.length > 0 && <ExtensionWidgets widgets={widgetsAboveEditor} />}

        {rawTerminal && workspace && (
          <RawTerminal
            key={rawTerminal.key}
            cwd={workspace}
            command={rawTerminal.command}
            onClose={() => setRawTerminal(null)}
          />
        )}

        <footer className="composer">
          {showSlashCompletions && (
            <div className="slash-menu slash-menu--completions" role="listbox" aria-label="Command argument completions">
              {slashCompletions.map((item, idx) => (
                <button
                  key={`${item.value}-${idx}`}
                  className={`slash-menu__item ${idx === slashCompletionIndex ? "slash-menu__item--active" : ""}`}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => applySlashCompletion(item)}
                  role="option"
                  aria-selected={idx === slashCompletionIndex}
                >
                  <span className="slash-menu__name">{item.label}</span>
                  {item.description && <span className="slash-menu__description">{item.description}</span>}
                  <span className="slash-menu__source">{item.kind ?? "arg"}</span>
                </button>
              ))}
            </div>
          )}
          {slashMatches.length > 0 && (
            <div className="slash-menu" role="listbox" aria-label="Slash commands">
              {slashMatches.map((cmd, idx) => (
                <button
                  key={cmd.name}
                  className={`slash-menu__item ${idx === slashIndex ? "slash-menu__item--active" : ""}`}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => void executeSlashCommand(cmd.name)}
                  disabled={cmd.disabled}
                  role="option"
                  aria-selected={idx === slashIndex}
                >
                  <span className="slash-menu__name">{cmd.name}</span>
                  <span className="slash-menu__description">{cmd.description}</span>
                  {cmd.source && cmd.source !== "desktop" && (
                    <span className="slash-menu__source">{cmd.source}</span>
                  )}
                </button>
              ))}
            </div>
          )}
          <button
            className="composer__btn composer__btn--secondary"
            onClick={() => fileInputRef.current?.click()}
            disabled={streaming}
            title="Attach image"
            aria-label="Attach image"
            type="button"
          >
            <ImageIcon size={16} />
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            multiple
            className="composer__file-input"
            onChange={(e) => {
              void addImageFiles(e.currentTarget.files ?? []);
              e.currentTarget.value = "";
            }}
          />
          <div
            className="composer__main"
            onDragOver={(e) => {
              if (!streaming) e.preventDefault();
            }}
            onDrop={(e) => {
              if (streaming) return;
              e.preventDefault();
              void addImageFiles(e.dataTransfer.files);
            }}
          >
            {voiceError && <div className="composer__voice-error">{voiceError}</div>}
            {attachments.length > 0 && (
              <div className="composer__attachments" aria-label="Image attachments">
                {attachments.map((attachment) => (
                  <div key={attachment.id} className="composer__attachment">
                    <img src={imageDataUrl(attachment)} alt="" />
                    <span title={attachment.name}>{attachment.name}</span>
                    <button
                      type="button"
                      onClick={() => removeAttachment(attachment.id)}
                      aria-label={`Remove ${attachment.name}`}
                    >
                      <X size={12} />
                    </button>
                  </div>
                ))}
              </div>
            )}
            <textarea
              ref={composerInputRef}
              className="composer__input"
              placeholder="Message Pix… (Shift+Enter, / commands, ! shell, paste/drop images)"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onPaste={(e) => {
                if (streaming) return;
                const files = Array.from(e.clipboardData.files).filter((file) => file.type.startsWith("image/"));
                if (files.length > 0) {
                  e.preventDefault();
                  void addImageFiles(files);
                }
              }}
              onKeyDown={(e) => {
              if (showSlashCompletions) {
                if (e.key === "ArrowDown") {
                  e.preventDefault();
                  setSlashCompletionIndex((idx) => (idx + 1) % slashCompletions.length);
                  return;
                }
                if (e.key === "ArrowUp") {
                  e.preventDefault();
                  setSlashCompletionIndex((idx) => (idx - 1 + slashCompletions.length) % slashCompletions.length);
                  return;
                }
                if (e.key === "Tab") {
                  e.preventDefault();
                  const item = slashCompletions[slashCompletionIndex];
                  if (item) applySlashCompletion(item);
                  return;
                }
                if (e.key === "Escape") {
                  e.preventDefault();
                  setSlashCompletions([]);
                  setSlashCompletionIndex(0);
                  return;
                }
              }
              if (slashMatches.length > 0) {
                if (e.key === "ArrowDown") {
                  e.preventDefault();
                  setSlashIndex((idx) => (idx + 1) % slashMatches.length);
                  return;
                }
                if (e.key === "ArrowUp") {
                  e.preventDefault();
                  setSlashIndex((idx) => (idx - 1 + slashMatches.length) % slashMatches.length);
                  return;
                }
                if (e.key === "Tab") {
                  e.preventDefault();
                  const cmd = slashMatches[slashIndex];
                  if (cmd) setInput(`${cmd.name} `);
                  return;
                }
                if (e.key === "Escape") {
                  e.preventDefault();
                  setInput("");
                  setSlashIndex(0);
                  return;
                }
              }
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                if (slashMatches.length > 0 && !hasSlashArguments(input)) {
                  const cmd = slashMatches[slashIndex];
                  if (cmd && !cmd.disabled) void executeSlashCommand(cmd.name);
                  return;
                }
                void send();
              }
            }}
              rows={1}
              disabled={streaming}
            />
          </div>
          {streaming ? (
            <button
              className="composer__btn composer__btn--stop"
              onClick={abort}
              title="Stop"
              aria-label="Stop"
            >
              <Square size={14} fill="currentColor" strokeWidth={0} />
            </button>
          ) : (
            <button
              className="composer__btn composer__btn--secondary"
              onClick={toggleVoiceDictation}
              disabled={!voiceSupported}
              title={voiceSupported ? (voiceListening ? "Stop voice dictation" : "Start voice dictation") : "Voice dictation unavailable"}
              aria-label={voiceListening ? "Stop voice dictation" : "Start voice dictation"}
              aria-pressed={voiceListening}
              type="button"
            >
              {voiceListening ? <MicOff size={16} /> : <Mic size={16} />}
            </button>
          )}
        </footer>

        {widgetsBelowEditor.length > 0 && <ExtensionWidgets widgets={widgetsBelowEditor} />}

        <StatusBar
          session={session}
          extensionStatuses={extensionStatusEntries}
          extensionChrome={extensionChromeActive ? extensionChrome : undefined}
        />
      </main>
      {extensionToasts.length > 0 && <ExtensionToasts toasts={extensionToasts} />}
      {extensionDialog && (
        <ExtensionDialog
          request={extensionDialog}
          value={extensionDialogValue}
          onValueChange={setExtensionDialogValue}
          onCancel={() => closeExtensionDialog({ cancelled: true })}
          onSubmit={(payload) => closeExtensionDialog(payload)}
        />
      )}
      {modelPickerOpen && (
        <ModelPicker
          models={modelPickerMatches}
          query={modelPickerQuery}
          onQueryChange={setModelPickerQuery}
          onCancel={() => setModelPickerOpen(false)}
          onSelect={(model) => void selectModel(model.ref)}
        />
      )}
    </div>
  );
}

// -- Extension UI ---------------------------------------------------------

function ExtensionDialog({
  request,
  value,
  onValueChange,
  onCancel,
  onSubmit,
}: {
  request: ExtensionUIRequest;
  value: string;
  onValueChange: (value: string) => void;
  onCancel: () => void;
  onSubmit: (payload: Record<string, unknown>) => void;
}) {
  const title = request.title ?? "Extension request";
  const timeoutMs = typeof request.timeout === "number" && Number.isFinite(request.timeout) && request.timeout > 0
    ? request.timeout
    : undefined;
  const [selectQuery, setSelectQuery] = useState("");
  const [remainingMs, setRemainingMs] = useState(timeoutMs ?? 0);
  const options = request.options ?? [];
  const filteredOptions = useMemo(() => {
    const query = selectQuery.trim().toLowerCase();
    if (!query) return options;
    return options.filter((option) => option.toLowerCase().includes(query));
  }, [options, selectQuery]);

  useEffect(() => {
    if (!timeoutMs) return;
    const startedAt = Date.now();
    setRemainingMs(timeoutMs);
    const intervalId = window.setInterval(() => {
      setRemainingMs(Math.max(0, timeoutMs - (Date.now() - startedAt)));
    }, 250);
    const timeoutId = window.setTimeout(onCancel, Math.max(0, timeoutMs - 100));
    return () => {
      window.clearInterval(intervalId);
      window.clearTimeout(timeoutId);
    };
  }, [onCancel, request.id, timeoutMs]);

  const timeoutLabel = timeoutMs ? `${Math.ceil(remainingMs / 1000)}s left` : undefined;
  const shellClass = "fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-6";
  const cardClass = "flex max-h-[min(720px,calc(100vh-48px))] w-full max-w-xl flex-col gap-3 overflow-hidden rounded-xl border border-claude-dark-elevated bg-claude-dark-elevated p-5 text-claude-on-dark shadow-2xl";
  const inputClass = "w-full rounded-lg border border-[#363430] bg-claude-dark px-3 py-2 text-sm text-claude-on-dark outline-none transition focus:border-claude-coral";
  const secondaryButtonClass = "rounded-lg border border-[#363430] px-3 py-2 text-sm text-claude-on-dark transition hover:bg-white/5 focus:outline-none focus:ring-2 focus:ring-claude-coral/50";
  const primaryButtonClass = "rounded-lg border border-claude-coral bg-claude-coral px-3 py-2 text-sm font-medium text-claude-on-primary transition hover:bg-claude-coral-active focus:outline-none focus:ring-2 focus:ring-claude-coral/50";

  const header = (
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0">
        <h2 className="m-0 text-base font-semibold tracking-tight text-claude-on-dark">{title}</h2>
        {request.message && <p className="mt-1 text-sm leading-5 text-claude-on-dark-soft">{request.message}</p>}
      </div>
      {timeoutLabel && (
        <div className="flex shrink-0 items-center gap-1 rounded-full border border-[#363430] bg-claude-dark px-2 py-1 font-mono text-[11px] text-claude-on-dark-soft" title="This extension request has a timeout">
          <Clock3 size={12} />
          {timeoutLabel}
        </div>
      )}
    </div>
  );

  if (request.method === "select") {
    return (
      <div className={shellClass} role="dialog" aria-modal="true" aria-label={title} onKeyDown={(e) => { if (e.key === "Escape") onCancel(); }}>
        <div className={cardClass}>
          {header}
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-claude-on-dark-soft" size={14} />
            <input
              className={`${inputClass} pl-9`}
              value={selectQuery}
              onChange={(e) => setSelectQuery(e.target.value)}
              placeholder={options.length > 8 ? "Search options…" : "Filter options…"}
              autoFocus
            />
          </div>
          <div className="flex items-center justify-between text-xs text-claude-on-dark-soft">
            <span>{filteredOptions.length} of {options.length} options</span>
            {options.length > 12 && <span>Long list scrolls in place</span>}
          </div>
          <div className="flex max-h-[min(420px,48vh)] flex-col gap-2 overflow-y-auto pr-1">
            {filteredOptions.length === 0 ? (
              <div className="rounded-lg border border-dashed border-[#363430] p-3 text-sm text-claude-on-dark-soft">No matching options.</div>
            ) : filteredOptions.map((option, index) => (
              <button key={`${option}-${index}`} className="rounded-lg border border-[#363430] bg-claude-dark p-3 text-left text-sm text-claude-on-dark transition hover:border-claude-coral hover:bg-white/5 focus:outline-none focus:ring-2 focus:ring-claude-coral/50" onClick={() => onSubmit({ value: option })}>
                {option}
              </button>
            ))}
          </div>
          <div className="flex justify-end gap-2">
            <button className={secondaryButtonClass} onClick={onCancel}>Cancel</button>
          </div>
        </div>
      </div>
    );
  }
  if (request.method === "confirm") {
    return (
      <div className={shellClass} role="dialog" aria-modal="true" aria-label={title} onKeyDown={(e) => { if (e.key === "Escape") onCancel(); }}>
        <div className={cardClass}>
          {header}
          <div className="flex justify-end gap-2">
            <button className={secondaryButtonClass} onClick={onCancel}>Cancel</button>
            <button className={secondaryButtonClass} onClick={() => onSubmit({ confirmed: false })}>No</button>
            <button className={primaryButtonClass} onClick={() => onSubmit({ confirmed: true })}>Yes</button>
          </div>
        </div>
      </div>
    );
  }
  const multiLine = request.method === "editor";
  return (
    <div className={shellClass} role="dialog" aria-modal="true" aria-label={title} onKeyDown={(e) => { if (e.key === "Escape") onCancel(); }}>
      <div className={cardClass}>
        {header}
        {multiLine ? (
          <textarea
            className={`${inputClass} min-h-48 resize-y font-mono text-xs leading-5`}
            value={value}
            onChange={(e) => onValueChange(e.target.value)}
            autoFocus
            rows={8}
          />
        ) : (
          <input
            className={inputClass}
            value={value}
            placeholder={request.placeholder}
            onChange={(e) => onValueChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") onSubmit({ value });
              if (e.key === "Escape") onCancel();
            }}
            autoFocus
          />
        )}
        <div className="flex justify-end gap-2">
          <button className={secondaryButtonClass} onClick={onCancel}>Cancel</button>
          <button className={primaryButtonClass} onClick={() => onSubmit({ value })}>Submit</button>
        </div>
      </div>
    </div>
  );
}

function ExtensionWidgets({ widgets }: { widgets: ExtensionWidget[] }) {
  return (
    <div className="mx-4 mb-3 flex flex-col gap-2" aria-label="Extension widgets">
      {widgets.map((widget) => (
        <div className="rounded-xl border border-[#d8cfc0] bg-claude-card p-3 text-claude-ink" key={widget.key}>
          <div className="mb-2 flex items-center justify-between gap-3 text-xs font-medium uppercase tracking-[0.14em] text-claude-muted">
            <span className="flex min-w-0 items-center gap-2">
              <Wrench size={13} />
              <span className="truncate" title={widget.key}>{widget.key}</span>
            </span>
            <span>{widget.degradedComponent ? "component degraded" : widget.placement === "belowEditor" ? "below editor" : "above editor"}</span>
          </div>
          <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-claude-dark p-3 font-mono text-xs leading-5 text-claude-on-dark">{widget.lines.join("\n")}</pre>
        </div>
      ))}
    </div>
  );
}

function ExtensionToasts({ toasts }: { toasts: ExtensionToast[] }) {
  return (
    <div className="extension-toasts" aria-live="polite">
      {toasts.map((toast) => (
        <div key={toast.id} className={`extension-toast extension-toast--${toast.type}`}>
          {toast.message}
        </div>
      ))}
    </div>
  );
}

function ModelPicker({
  models,
  query,
  onQueryChange,
  onCancel,
  onSelect,
}: {
  models: DesktopModel[];
  query: string;
  onQueryChange: (value: string) => void;
  onCancel: () => void;
  onSelect: (model: DesktopModel) => void;
}) {
  return (
    <div className="extension-modal" role="dialog" aria-modal="true" aria-label="Select model">
      <div className="extension-modal__card extension-modal__card--wide">
        <h2>Select model</h2>
        <input
          className="extension-modal__input"
          placeholder="Filter by provider, id, or name…"
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          autoFocus
        />
        <div className="extension-modal__options extension-modal__options--scroll">
          {models.length === 0 ? (
            <div className="extension-modal__empty">No available models match this filter.</div>
          ) : (
            models.map((model) => (
              <button key={model.ref} className="extension-modal__option" onClick={() => onSelect(model)}>
                <span>{model.name}</span>
                <small>
                  {model.ref}
                  {model.current ? " · current" : ""}
                  {model.reasoning ? " · reasoning" : ""}
                </small>
              </button>
            ))
          )}
        </div>
        <div className="extension-modal__actions">
          <button onClick={onCancel}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

// -- Status bar -----------------------------------------------------------

function StatusBar({
  session,
  extensionStatuses,
  extensionChrome,
}: {
  session: SessionState;
  extensionStatuses: [string, string][];
  extensionChrome?: ExtensionChromeState;
}) {
  const model = session.model;
  const modelLabel = model
    ? model.name ?? model.id ?? "unknown model"
    : "no model";
  const provider = model?.provider;
  const thinking = session.thinkingLevel && session.thinkingLevel !== "off"
    ? session.thinkingLevel
    : null;
  const usage = session.contextUsage;
  const pct = usage && typeof usage.percent === "number" ? usage.percent : null;
  const tokens = usage && typeof usage.tokens === "number" ? usage.tokens : null;
  const windowSize = usage?.contextWindow ?? model?.contextWindow;

  return (
    <div className="statusbar" role="status" aria-live="polite">
      <span className="statusbar__item statusbar__model" title={model?.id ?? ""}>
        <Cpu size={11} />
        {provider && <span className="statusbar__provider">{provider}</span>}
        <span className="statusbar__model-name">{modelLabel}</span>
      </span>
      {thinking && (
        <span className="statusbar__item" title="Thinking level">
          <Brain size={11} />
          <span>{thinking}</span>
        </span>
      )}
      {pct !== null && (
        <span
          className="statusbar__item statusbar__ctx"
          title={
            tokens !== null && windowSize
              ? `${tokens.toLocaleString()} / ${windowSize.toLocaleString()} tokens`
              : "Context usage"
          }
        >
          <Gauge size={11} />
          <span className="statusbar__ctx-pct">{Math.round(pct)}%</span>
          <span className="statusbar__ctx-bar">
            <span
              className="statusbar__ctx-fill"
              style={{ width: `${Math.min(100, Math.max(0, pct))}%` }}
            />
          </span>
        </span>
      )}
      {extensionStatuses.map(([key, text]) => (
        <span key={key} className="statusbar__item statusbar__extension" title={key}>
          <span className="statusbar__extension-key">{key}</span>
          <span>{text}</span>
        </span>
      ))}
      {extensionChrome?.workingMessage && (
        <span className="statusbar__item statusbar__extension" title="Extension working message">
          <Activity size={11} />
          <span>{extensionChrome.workingMessage}</span>
        </span>
      )}
      {extensionChrome?.workingVisible === false && (
        <span className="statusbar__item statusbar__extension" title="Extension hid the working indicator">
          <Activity size={11} />
          <span>loader hidden</span>
        </span>
      )}
      {extensionChrome?.workingIndicatorFrames && (
        <span className="statusbar__item statusbar__extension" title="Extension customized the working indicator">
          <Activity size={11} />
          <span>{extensionChrome.workingIndicatorFrames.length === 0 ? "indicator hidden" : "custom indicator"}</span>
        </span>
      )}
      {extensionChrome?.hiddenThinkingLabel && (
        <span className="statusbar__item statusbar__extension" title="Hidden thinking label">
          <Brain size={11} />
          <span>{extensionChrome.hiddenThinkingLabel}</span>
        </span>
      )}
      {extensionChrome?.headerActive && (
        <span className="statusbar__item statusbar__extension" title="Desktop degrades custom extension header components to a status badge">
          <PanelTop size={11} />
          <span>custom header</span>
        </span>
      )}
      {extensionChrome?.footerActive && (
        <span className="statusbar__item statusbar__extension" title="Desktop degrades custom extension footer components to a status badge">
          <PanelBottom size={11} />
          <span>custom footer</span>
        </span>
      )}
      {extensionChrome?.customUiRequested && (
        <span className="statusbar__item statusbar__extension" title="Desktop returned undefined for an extension custom component request">
          <Puzzle size={11} />
          <span>custom UI degraded</span>
        </span>
      )}
      {extensionChrome?.editorComponentActive && (
        <span className="statusbar__item statusbar__extension" title="Desktop keeps the default composer instead of rendering a custom extension editor component">
          <Keyboard size={11} />
          <span>custom editor degraded</span>
        </span>
      )}
      {extensionChrome?.autocompleteProviderActive && (
        <span className="statusbar__item statusbar__extension" title="Extension autocomplete providers are acknowledged but not composed into the desktop autocomplete stack">
          <Keyboard size={11} />
          <span>extension autocomplete</span>
        </span>
      )}
      {session.isCompacting && <span className="statusbar__item statusbar__compact">compacting…</span>}
    </div>
  );
}

// -- Tab helpers ---------------------------------------------------------

function sessionLabelFor(
  path: string,
  sessions: SessionSummary[],
  current: SessionState,
  restoredTitles: Record<string, string> = {},
): string {
  const found = sessions.find((s) => s.path === path);
  if (current.sessionFile === path) {
    const summaryLabel = found ? found.name ?? truncate(found.firstMessage, 24) : restoredTitles[path];
    return current.sessionName ?? summaryLabel ?? shortId(current.sessionId) ?? "Session";
  }
  if (found) return found.name ?? truncate(found.firstMessage, 24) ?? "Untitled";
  if (restoredTitles[path]) return restoredTitles[path];
  return shortId(path.split("/").pop() ?? path);
}

function persistedTabsFor(
  openTabs: string[],
  activeTabId: string | null,
  sessions: SessionSummary[],
  current: SessionState,
  restoredTitles: Record<string, string>,
  scroll: ReadonlyMap<string, TabScrollState> = new Map(),
): PersistedTabs {
  const titles: Record<string, string> = {};
  const scrollState: Record<string, TabScrollState> = {};
  for (const path of openTabs) {
    const label = sessionLabelFor(path, sessions, current, restoredTitles).trim();
    if (label) titles[path] = label;
    const savedScroll = scroll.get(path);
    if (savedScroll) scrollState[path] = savedScroll;
  }
  return {
    openTabs,
    activeTabId,
    titles,
    ...(Object.keys(scrollState).length > 0 ? { scroll: scrollState } : {}),
  };
}

function pruneRestoredTabTitles(
  restoredTitles: Record<string, string>,
  sessions: SessionSummary[],
): Record<string, string> {
  if (Object.keys(restoredTitles).length === 0) return restoredTitles;
  const sessionPaths = new Set(sessions.map((session) => session.path));
  const next: Record<string, string> = {};
  for (const [path, title] of Object.entries(restoredTitles)) {
    if (!sessionPaths.has(path)) next[path] = title;
  }
  return next;
}

function mergeSlashCommands(commands: SlashCommandDef[]): SlashCommandDef[] {
  const seen = new Set<string>();
  const merged: SlashCommandDef[] = [];
  for (const command of commands) {
    const key = command.name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(command);
  }
  return merged;
}

function toSlashCommandDefs(commands: SdkSlashCommand[]): SlashCommandDef[] {
  return commands
    .filter((command) => typeof command.name === "string" && command.name.trim())
    .map((command) => ({
      name: `/${command.name.replace(/^\/+/, "")}`,
      description: command.description ?? `${command.source ?? "SDK"} command`,
      source: command.source,
    }));
}

function hasSlashArguments(input: string): boolean {
  return /^\/\S+\s+/.test(input.trimStart());
}

function parseSlashInput(input: string): { query: string; command: string | null; argumentPrefix: string | null } | null {
  if (!input.startsWith("/")) return null;
  const withoutSlash = input.slice(1);
  const match = withoutSlash.match(/^(\S+)(?:\s+(.*))?$/s);
  if (!match) return { query: withoutSlash.trimStart(), command: null, argumentPrefix: null };
  const command = match[1] ?? null;
  if (!command) return { query: withoutSlash.trimStart(), command: null, argumentPrefix: null };
  return {
    query: withoutSlash.trimStart(),
    command,
    argumentPrefix: match[2] ?? null,
  };
}

function parseComposerCompletionTarget(input: string): ComposerCompletionTarget | null {
  if (input.startsWith("/")) {
    const parsed = parseSlashInput(input);
    if (!parsed?.command || parsed.argumentPrefix === null) return null;
    return { kind: "slash-arg", command: parsed.command, prefix: parsed.argumentPrefix };
  }

  if (input.startsWith("!")) {
    const commandStart = input.startsWith("!!") ? 2 : 1;
    const token = trailingToken(input.slice(commandStart));
    if (!token || !looksLikePathPrefix(token.value)) return null;
    return {
      kind: "path",
      prefix: token.value,
      replaceStart: commandStart + token.start,
      replaceEnd: commandStart + token.end,
      trigger: "shell",
    };
  }

  const mention = input.match(/(^|\s)@([^\s]*)$/);
  if (!mention || mention.index === undefined) return null;
  const prefix = mention[2] ?? "";
  return {
    kind: "path",
    prefix,
    replaceStart: mention.index + mention[1].length,
    replaceEnd: input.length,
    trigger: "mention",
  };
}

function trailingToken(text: string): { value: string; start: number; end: number } | null {
  const match = text.match(/(?:^|\s)([^\s]*)$/);
  if (!match || match.index === undefined) return null;
  const value = match[1] ?? "";
  return { value, start: match.index + match[0].length - value.length, end: text.length };
}

function looksLikePathPrefix(prefix: string): boolean {
  return prefix.length > 0 && (prefix.includes("/") || prefix.includes("\\") || prefix.startsWith(".") || prefix.startsWith("~"));
}

function readImageAttachment(file: File): Promise<ImageAttachment> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("Failed to read image"));
    reader.onload = () => {
      const result = typeof reader.result === "string" ? reader.result : "";
      const comma = result.indexOf(",");
      const data = comma >= 0 ? result.slice(comma + 1) : result;
      resolve({ id: genId("img"), name: file.name || "pasted-image", mimeType: file.type || "image/png", data, size: file.size });
    };
    reader.readAsDataURL(file);
  });
}

function imageDataUrl(attachment: ImageAttachment): string {
  return `data:${attachment.mimeType};base64,${attachment.data}`;
}

// -- Helpers --------------------------------------------------------------

function estimateMessageHeight(message: ChatMessage): number {
  if (message.role === "user") {
    const textLines = Math.max(1, Math.ceil(message.text.length / 90));
    const attachmentRows = message.attachments?.length ? 4 : 0;
    return ESTIMATED_MESSAGE_HEIGHT + (textLines + attachmentRows - 1) * 20;
  }

  let lines = 0;
  for (const part of message.parts) {
    if (part.kind === "text") lines += Math.max(1, Math.ceil(part.text.length / 90));
    else lines += 2;
  }
  return ESTIMATED_MESSAGE_HEIGHT + Math.max(0, lines - 1) * 20;
}

function estimatedHistoryGapHeight(bytes: number | undefined): number {
  if (!bytes || !Number.isFinite(bytes) || bytes <= 0) return 0;
  const approxChunks = Math.ceil(bytes / (16 * 1024 * 1024));
  return Math.min(4800, Math.max(180, approxChunks * 180));
}

function scrollTopForAnchor(
  container: HTMLDivElement | null,
  messages: readonly ChatMessage[],
  heights: ReadonlyMap<string, number>,
  anchorId: string | undefined,
  anchorOffset: number | undefined,
): number | undefined {
  if (!anchorId) return undefined;
  const domTop = container ? scrollTopForDomAnchor(container, anchorId, anchorOffset) : undefined;
  if (domTop !== undefined) return domTop;

  let top = 0;
  for (const message of messages) {
    if (message.id === anchorId) return top + Math.max(0, anchorOffset ?? 0);
    top += heights.get(message.id) ?? estimateMessageHeight(message);
  }
  return undefined;
}

function domScrollAnchorFor(container: HTMLDivElement): Pick<TabScrollState, "anchorId" | "anchorOffset" | "anchorEntryOffset"> | undefined {
  const containerTop = container.getBoundingClientRect().top;
  for (const node of Array.from(container.querySelectorAll<HTMLElement>(".msg[data-message-id]"))) {
    const anchorId = node.dataset.messageId;
    if (!anchorId) continue;
    const rect = node.getBoundingClientRect();
    if (!Number.isFinite(rect.height) || rect.height <= 0) continue;
    if (rect.bottom < containerTop) continue;
    return { anchorId, anchorOffset: Math.max(0, containerTop - rect.top), ...domEntryOffsetFor(node) };
  }
  return undefined;
}

function scrollTopForDomAnchor(
  container: HTMLDivElement,
  anchorId: string,
  anchorOffset: number | undefined,
): number | undefined {
  const node = Array.from(container.querySelectorAll<HTMLElement>(".msg[data-message-id]"))
    .find((candidate) => candidate.dataset.messageId === anchorId);
  if (!node) return undefined;
  const containerTop = container.getBoundingClientRect().top;
  const nodeTop = node.getBoundingClientRect().top;
  const nextScrollTop = container.scrollTop + nodeTop - containerTop + Math.max(0, anchorOffset ?? 0);
  return Number.isFinite(nextScrollTop) ? nextScrollTop : undefined;
}

function domEntryOffsetFor(node: HTMLElement): Pick<TabScrollState, "anchorEntryOffset"> {
  const raw = node.dataset.entryOffset;
  if (!raw) return {};
  const value = Number(raw);
  return Number.isFinite(value) ? { anchorEntryOffset: Math.max(0, value) } : {};
}

function MessageView({
  message,
  measureRef,
}: {
  message: ChatMessage;
  measureRef?: (id: string, node: HTMLDivElement | null) => void;
}) {
  return (
    <div ref={(node) => measureRef?.(message.id, node)} data-message-id={message.id} data-entry-offset={message.entryOffset} className={`msg msg--${message.role}`}>
      <div className="msg__avatar">
        {message.role === "user" ? <User size={14} /> : <Bot size={14} />}
      </div>
      <div className="msg__body">
        {message.role === "user" ? (
          <>
            <div className="msg__text">{message.text}</div>
            {message.attachments && message.attachments.length > 0 && (
              <div className="msg__attachments">
                {message.attachments.map((attachment) => (
                  <figure key={attachment.id} className="msg__attachment">
                    <img src={imageDataUrl(attachment)} alt={attachment.name} />
                    <figcaption>{attachment.name}</figcaption>
                  </figure>
                ))}
              </div>
            )}
          </>
        ) : message.parts.length === 0 ? (
          <div className="msg__placeholder">…</div>
        ) : (
          message.parts.map((p, i) => <PartView key={i} part={p} />)
        )}
      </div>
    </div>
  );
}

function PartView({ part }: { part: AssistantPart }) {
  if (part.kind === "text") {
    return <div className="msg__text">{part.text}</div>;
  }
  return <ToolCallView part={part} />;
}

function ToolCallView({ part }: { part: ToolPart }) {
  const [open, setOpen] = useState(false);
  const statusText =
    part.status === "running" ? "running…" : part.status === "error" ? "error" : "done";
  const renderer = lookup(part.name) ?? defaultRenderer;
  const summary = renderer.summarize({
    name: part.name,
    args: part.args,
    result: part.result,
    status: part.status,
    isError: part.status === "error",
  } satisfies ToolRenderProps);
  return (
    <div className={`tool tool--${part.status}`}>
      <button className="tool__head" onClick={() => setOpen((v) => !v)}>
        {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        <Wrench size={12} />
        <span className="tool__name">{part.name}</span>
        {summary && <span className="tool__args">{truncate(summary, 120)}</span>}
        <span className="tool__status">{statusText}</span>
      </button>
      {open && (
        <div className="tool__body">
          {renderer.render({
            name: part.name,
            args: part.args,
            result: part.result,
            status: part.status,
            isError: part.status === "error",
          })}
        </div>
      )}
    </div>
  );
}

function updateLastAssistant(
  prev: ChatMessage[],
  fn: (parts: AssistantPart[]) => AssistantPart[],
): ChatMessage[] {
  const lastIdx = [...prev].reverse().findIndex((m) => m.role === "assistant");
  if (lastIdx === -1) {
    return [...prev, { id: genId("a"), role: "assistant", parts: fn([]) }];
  }
  const realIdx = prev.length - 1 - lastIdx;
  const target = prev[realIdx];
  if (target.role !== "assistant") return prev;
  const next = [...prev];
  next[realIdx] = { ...target, parts: fn(target.parts) };
  return next;
}

function appendText(parts: AssistantPart[], delta: string): AssistantPart[] {
  const last = parts[parts.length - 1];
  if (last && last.kind === "text") {
    return [...parts.slice(0, -1), { ...last, text: last.text + delta }];
  }
  return [...parts, { kind: "text", text: delta }];
}

function toChatMessages(history: HistoryMessage[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  let fallbackIndex = 0;
  for (const m of history) {
    const stableId = historyMessageStableId(m, fallbackIndex++);
    const entryOffset = historyMessageEntryOffset(m);
    if (m.role === "user") {
      const text = contentToText(m.content);
      if (text) out.push({ id: stableId ?? genId("u"), role: "user", text, entryOffset });
      continue;
    }

    if (m.role === "assistant") {
      const parts: AssistantPart[] = [];
      for (const block of Array.isArray(m.content) ? m.content : []) {
        if (block.type === "text" && typeof block.text === "string" && block.text.length > 0) {
          parts.push({ kind: "text", text: block.text });
        } else if (block.type === "toolCall" && block.id && block.name) {
          parts.push({
            kind: "tool",
            toolCallId: block.id,
            name: block.name,
            args: block.arguments,
            status: "running",
          });
        }
      }
      if (parts.length > 0) out.push({ id: stableId ?? genId("a"), role: "assistant", parts, entryOffset });
      continue;
    }

    if (m.role === "toolResult" && typeof m.toolCallId === "string") {
      const result = m.details ?? contentToText(m.content) ?? undefined;
      const updated = updateToolResult(out, m.toolCallId, result, Boolean(m.isError));
      const toolName = typeof m.toolName === "string" ? m.toolName : undefined;
      if (!updated && toolName) {
        out.push({
          id: stableId ?? genId("a"),
          role: "assistant",
          entryOffset,
          parts: [
            {
              kind: "tool",
              toolCallId: m.toolCallId,
              name: toolName,
              args: undefined,
              result,
              status: m.isError ? "error" : "done",
            },
          ],
        });
      }
    }
  }
  return out;
}

function historyMessageEntryOffset(message: HistoryMessage): number | undefined {
  const value = (message as Record<string, unknown>).__pixSessionEntryOffset;
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : undefined;
}

function historyMessageStableId(message: HistoryMessage, fallbackIndex: number): string | undefined {
  if (typeof message.__pixSessionEntryId === "string" && message.__pixSessionEntryId.length > 0) {
    return `h-${message.__pixSessionEntryId}`;
  }
  if (typeof message.role !== "string") return undefined;
  const timestampValue = (message as Record<string, unknown>).timestamp;
  const timestamp = typeof timestampValue === "number" || typeof timestampValue === "string"
    ? String(timestampValue)
    : undefined;
  if (timestamp) return `h-${message.role}-${timestamp}-${fallbackIndex}`;
  return undefined;
}

function updateToolResult(
  messages: ChatMessage[],
  toolCallId: string,
  result: unknown,
  isError: boolean,
): boolean {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== "assistant") continue;
    const idx = msg.parts.findIndex((p) => p.kind === "tool" && p.toolCallId === toolCallId);
    if (idx === -1) continue;
    const part = msg.parts[idx];
    if (part.kind !== "tool") return false;
    msg.parts[idx] = { ...part, result, status: isError ? "error" : "done" };
    return true;
  }
  return false;
}

function updateLastTool(
  prev: ChatMessage[],
  toolCallId: string,
  update: Pick<ToolPart, "status"> & { result?: unknown },
): ChatMessage[] {
  for (let messageIndex = prev.length - 1; messageIndex >= 0; messageIndex--) {
    const message = prev[messageIndex];
    if (message.role !== "assistant") continue;
    const partIndex = message.parts.findIndex((part) => part.kind === "tool" && part.toolCallId === toolCallId);
    if (partIndex === -1) continue;
    const part = message.parts[partIndex];
    if (part.kind !== "tool") return prev;
    const next = [...prev];
    const nextParts = [...message.parts];
    nextParts[partIndex] = { ...part, ...update };
    next[messageIndex] = { ...message, parts: nextParts };
    return next;
  }
  return prev;
}

function contentToText(content: HistoryMessage["content"]): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((block) => (block.type === "text" && typeof block.text === "string" ? [block.text] : []))
    .join("\n");
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

function shortId(id: string | undefined): string {
  if (!id) return "";
  return id.slice(0, 8);
}

function workspaceBasename(p: string): string {
  // Be tolerant of trailing slashes on macOS paths.
  const norm = p.replace(/[/\\]+$/, "");
  const idx = Math.max(norm.lastIndexOf("/"), norm.lastIndexOf("\\"));
  return idx === -1 ? norm : norm.slice(idx + 1);
}

function tabsStorageKey(workspace: string): string {
  return `${TABS_KEY_PREFIX}${workspace}`;
}

async function readPersistedWorkspace(): Promise<string | null> {
  try {
    const saved = await invoke<string | null>("get_desktop_workspace");
    if (saved) return saved;
  } catch {
    // Fall through to the legacy localStorage value below.
  }
  try {
    return localStorage.getItem(WORKSPACE_KEY);
  } catch {
    return null;
  }
}

async function writePersistedWorkspace(workspace: string | null): Promise<void> {
  try {
    await invoke("save_desktop_workspace", { workspace });
  } catch {
    // Keep the legacy browser fallback for tests/restricted webviews.
  }
  try {
    if (workspace) localStorage.setItem(WORKSPACE_KEY, workspace);
    else localStorage.removeItem(WORKSPACE_KEY);
  } catch {
    // localStorage may be unavailable in tests or restricted webviews.
  }
}

async function readPersistedTabs(workspace: string): Promise<PersistedTabs> {
  try {
    const fromRust = await invoke<Partial<PersistedTabs>>("read_desktop_tabs", { workspace });
    const normalized = normalizePersistedTabsShape(fromRust);
    if (normalized.openTabs.length > 0 || normalized.activeTabId || normalized.titles || normalized.scroll) {
      return normalized;
    }
  } catch {
    // Fall through to the legacy localStorage value below.
  }
  try {
    const raw = localStorage.getItem(tabsStorageKey(workspace));
    if (!raw) return { openTabs: [], activeTabId: null };
    return normalizePersistedTabsShape(JSON.parse(raw) as Partial<PersistedTabs>);
  } catch {
    return { openTabs: [], activeTabId: null };
  }
}

async function writePersistedTabs(workspace: string, tabs: PersistedTabs): Promise<void> {
  const normalized = normalizePersistedTabsShape(tabs);
  try {
    await invoke("write_desktop_tabs", { workspace, tabs: normalized });
  } catch {
    // Keep legacy browser fallback below.
  }
  try {
    localStorage.setItem(tabsStorageKey(workspace), JSON.stringify(normalized));
  } catch {
    // localStorage may be unavailable in tests or restricted webviews.
  }
}

async function mutatePersistedTabs(
  workspace: string,
  command: "open_desktop_tab" | "close_desktop_tab" | "activate_desktop_tab",
  path: string,
): Promise<PersistedTabs> {
  try {
    const tabs = normalizePersistedTabsShape(await invoke<Partial<PersistedTabs>>(command, { workspace, path }));
    try { localStorage.setItem(tabsStorageKey(workspace), JSON.stringify(tabs)); } catch { /* ignore */ }
    return tabs;
  } catch (e) {
    const current = normalizePersistedTabsShape(readLegacyPersistedTabs(workspace));
    const openTabs = command === "close_desktop_tab"
      ? current.openTabs.filter((tab) => tab !== path)
      : uniqueStrings([...current.openTabs, path]);
    const activeTabId = command === "close_desktop_tab"
      ? current.activeTabId === path ? openTabs.at(-1) ?? null : current.activeTabId
      : path;
    const next = normalizePersistedTabsShape({ ...current, openTabs, activeTabId });
    try { localStorage.setItem(tabsStorageKey(workspace), JSON.stringify(next)); } catch { /* ignore */ }
    throw e;
  }
}

async function switchDesktopSession(workspace: string, sessionPath: string): Promise<{ success: boolean; error?: string; tabs?: PersistedTabs }> {
  const resp = await invoke<{ success: boolean; error?: string; tabs?: Partial<PersistedTabs> }>("switch_desktop_session", {
    workspace,
    sessionPath,
  });
  const tabs = normalizePersistedTabsShape(resp.tabs);
  if (tabs.openTabs.length > 0 || tabs.activeTabId || tabs.titles || tabs.scroll) {
    try { localStorage.setItem(tabsStorageKey(workspace), JSON.stringify(tabs)); } catch { /* ignore */ }
    return { ...resp, tabs };
  }
  return { success: resp.success, error: resp.error };
}

function readLegacyPersistedTabs(workspace: string): Partial<PersistedTabs> | null {
  try {
    const raw = localStorage.getItem(tabsStorageKey(workspace));
    return raw ? JSON.parse(raw) as Partial<PersistedTabs> : null;
  } catch {
    return null;
  }
}

function normalizePersistedTabsShape(tabs: Partial<PersistedTabs> | null | undefined): PersistedTabs {
  const openTabs = uniqueStrings(
    Array.isArray(tabs?.openTabs)
      ? tabs.openTabs.filter((p): p is string => typeof p === "string" && p.length > 0)
      : [],
  );
  const activeTabId = typeof tabs?.activeTabId === "string" && openTabs.includes(tabs.activeTabId)
    ? tabs.activeTabId
    : null;
  const titles = normalizePersistedTabTitles(openTabs, tabs?.titles);
  const scroll = normalizePersistedTabScroll(openTabs, tabs?.scroll);
  return { openTabs, activeTabId, ...(titles ? { titles } : {}), ...(scroll ? { scroll } : {}) };
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values.filter((value) => value.length > 0)));
}

function normalizePersistedTabTitles(openTabs: string[], value: unknown): Record<string, string> | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const tabSet = new Set(openTabs);
  const titles: Record<string, string> = {};
  for (const [path, title] of Object.entries(value)) {
    if (!tabSet.has(path) || typeof title !== "string") continue;
    const trimmed = title.trim();
    if (trimmed) titles[path] = trimmed;
  }
  return Object.keys(titles).length > 0 ? titles : undefined;
}

function normalizePersistedTabScroll(openTabs: string[], value: unknown): Record<string, TabScrollState> | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const tabSet = new Set(openTabs);
  const scroll: Record<string, TabScrollState> = {};
  for (const [path, state] of Object.entries(value)) {
    if (!tabSet.has(path) || typeof state !== "object" || state === null) continue;
    const raw = state as Partial<TabScrollState>;
    const anchorId = typeof raw.anchorId === "string" && raw.anchorId.length > 0 ? raw.anchorId : undefined;
    const anchorOffset = typeof raw.anchorOffset === "number" && Number.isFinite(raw.anchorOffset)
      ? Math.max(0, raw.anchorOffset)
      : undefined;
    const anchorEntryOffset = typeof raw.anchorEntryOffset === "number" && Number.isFinite(raw.anchorEntryOffset)
      ? Math.max(0, raw.anchorEntryOffset)
      : undefined;
    const followOutput = raw.followOutput !== false;
    if (!followOutput && !anchorId && anchorEntryOffset === undefined) continue;
    scroll[path] = {
      followOutput,
      ...(anchorId ? { anchorId, anchorOffset: anchorOffset ?? 0 } : {}),
      ...(anchorEntryOffset === undefined ? {} : { anchorEntryOffset }),
    };
  }
  return Object.keys(scroll).length > 0 ? scroll : undefined;
}
