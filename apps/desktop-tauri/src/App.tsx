import { useCallback, useEffect, useRef, useState } from "react";
import { invoke, Channel } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import {
  Sparkles,
  Send,
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
} from "lucide-react";
import { lookup, defaultRenderer } from "./tools";
import type { ToolRenderProps } from "./tools/types";
import "./App.css";

const WORKSPACE_KEY = "pix-desktop.workspace";
const TABS_KEY_PREFIX = "pix-desktop.tabs:";

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
  | { id: string; role: "user"; text: string }
  | { id: string; role: "assistant"; parts: AssistantPart[] };

type HistoryContent =
  | { type: "text"; text?: string }
  | { type: "thinking" }
  | { type: "image" }
  | { type: "toolCall"; id?: string; name?: string; arguments?: unknown };

type HistoryMessage =
  | { role: "user"; content?: string | HistoryContent[] }
  | { role: "assistant"; content?: HistoryContent[] }
  | { role: "toolResult"; toolCallId?: string; toolName?: string; content?: HistoryContent[]; details?: unknown; isError?: boolean }
  | { role?: string; [k: string]: unknown };

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
};

type SlashCommandDef = {
  name: string;
  description: string;
  disabled?: boolean;
};

const BASE_SLASH_COMMANDS: SlashCommandDef[] = [
  { name: "/help", description: "Show available Pix Desktop commands" },
  { name: "/new", description: "Start a new session" },
  { name: "/clear", description: "Clear the visible chat for this tab" },
  { name: "/refresh", description: "Refresh session list and status" },
  { name: "/abort", description: "Stop the current agent run" },
];

let nextId = 0;
const genId = (prefix: string) => `${prefix}-${++nextId}`;

// -- Component ------------------------------------------------------------

export default function App() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [slashIndex, setSlashIndex] = useState(0);
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [session, setSession] = useState<SessionState>({});
  const [loadingSessions, setLoadingSessions] = useState(false);
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
  const appliedWorkspaceRef = useRef<string | null>(null);
  const hydratedTabsWorkspaceRef = useRef<string | null>(null);
  /** Mirror of `messages` so stable callbacks can read the latest value. */
  const messagesRef = useRef<ChatMessage[]>([]);
  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);
  const subscribed = useRef(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  // -- RPC helpers -------------------------------------------------------

  const refreshSessions = useCallback(async () => {
    if (!workspace) {
      setSessions([]);
      return;
    }
    setLoadingSessions(true);
    try {
      const resp = await invoke<{ success: boolean; data?: { sessions: SessionSummary[] }; error?: string }>(
        "rpc_call",
        { cmd: { type: "pix:list_sessions" } },
      );
      if (resp.success && resp.data) {
        setSessions(resp.data.sessions);
      } else if (!resp.success) {
        setError(`list sessions: ${resp.error ?? "unknown"}`);
      }
    } catch (e) {
      setError(`list sessions: ${String(e)}`);
    } finally {
      setLoadingSessions(false);
    }
  }, [workspace]);

  const refreshState = useCallback(async () => {
    try {
      const resp = await invoke<{ success: boolean; data?: SessionState; error?: string }>(
        "rpc_call",
        { cmd: { type: "get_state" } },
      );
      if (resp.success && resp.data) {
        setSession(resp.data);
        setStreaming(Boolean(resp.data.isStreaming));
      }
    } catch (e) {
      setError(`get_state: ${String(e)}`);
    }
  }, []);

  const loadMessages = useCallback(async (path?: string) => {
    try {
      const resp = await invoke<{ success: boolean; data?: { messages: HistoryMessage[] }; error?: string }>(
        "rpc_call",
        { cmd: { type: "get_messages" } },
      );
      if (!resp.success) {
        setError(`get_messages: ${resp.error ?? "unknown"}`);
        return;
      }
      const next = toChatMessages(resp.data?.messages ?? []);
      setMessages(next);
      if (path) tabMessagesRef.current.set(path, next);
    } catch (e) {
      setError(`get_messages: ${String(e)}`);
    }
  }, []);

  const restoreTabsForWorkspace = useCallback(async (cwd: string, currentSessionFile?: string) => {
    const persisted = readPersistedTabs(cwd);
    const tabs = uniqueStrings([
      ...persisted.openTabs,
      ...(currentSessionFile ? [currentSessionFile] : []),
    ]);
    const active = persisted.activeTabId && tabs.includes(persisted.activeTabId)
      ? persisted.activeTabId
      : currentSessionFile ?? tabs[0] ?? null;

    tabMessagesRef.current.clear();
    hydratedTabsWorkspaceRef.current = cwd;
    setOpenTabs(tabs);
    setActiveTabId(active);
    setMessages([]);

    if (active && active !== currentSessionFile) {
      const resp = await invoke<{ success: boolean; error?: string }>("rpc_call", {
        cmd: { type: "switch_session", sessionPath: active },
      });
      if (!resp.success) {
        const fallback = currentSessionFile ?? null;
        const fallbackTabs = uniqueStrings([
          ...tabs.filter((p) => p !== active),
          ...(fallback ? [fallback] : []),
        ]);
        setError(`restore tab: ${resp.error ?? "switch_session failed"}`);
        setOpenTabs(fallbackTabs);
        setActiveTabId(fallback);
        await refreshState();
        if (fallback) await loadMessages(fallback);
        return;
      }
    }

    await refreshState();
    if (active) await loadMessages(active);
  }, [loadMessages, refreshState]);

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
      try { localStorage.setItem(WORKSPACE_KEY, newCwd); } catch { /* ignore */ }
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
    void refreshState();
  }, [refreshState]);

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
          try { localStorage.removeItem(WORKSPACE_KEY); } catch { /* ignore */ }
          setWorkspace(null);
          setError(`workspace '${workspace}' unavailable: ${resp.error ?? "?"}`);
          return;
        }
        appliedWorkspaceRef.current = workspace;
        await restoreTabsForWorkspace(workspace, resp.data?.sessionFile);
      })
      .catch((e) => setError(`restore workspace: ${String(e)}`));
  }, [workspace, restoreTabsForWorkspace]);

  // Persist open tabs per workspace after that workspace has been hydrated
  // from localStorage. This guard avoids overwriting saved tabs with the
  // initial empty React state during startup.
  useEffect(() => {
    if (!workspace || hydratedTabsWorkspaceRef.current !== workspace) return;
    writePersistedTabs(workspace, { openTabs, activeTabId });
  }, [workspace, openTabs, activeTabId]);

  // Refresh sessions whenever workspace changes (or on initial mount).
  useEffect(() => {
    if (workspace) void refreshSessions();
  }, [workspace, refreshSessions]);

  // Sync tab state with the active session: when the sidecar switches
  // sessions (new_session, switch_session, folder change) the sessionFile in
  // state updates. Make sure the new path is in openTabs and is active.
  useEffect(() => {
    const path = session.sessionFile;
    if (!path) return;
    if (activeTabId && activeTabId !== path) {
      // Old tab's messages are already in tabMessagesRef via switchSession,
      // but events since the last switch may have updated them — refresh.
      tabMessagesRef.current.set(activeTabId, messagesRef.current);
    }
    setOpenTabs((tabs) => (tabs.includes(path) ? tabs : [...tabs, path]));
    setActiveTabId(path);
    if (!tabMessagesRef.current.has(path) && messagesRef.current.length === 0) {
      void loadMessages(path);
    }
  }, [session.sessionFile, activeTabId, loadMessages]);

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

  const handleEvent = useCallback(
    (ev: RpcEvent) => {
      switch (ev.type) {
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
          break;
        case "message_start":
          if (ev.message?.role === "assistant") {
            setMessages((prev) => [...prev, { id: genId("a"), role: "assistant", parts: [] }]);
          }
          break;
        case "message_update": {
          const d = ev.assistantMessageEvent;
          if (d?.type === "text_delta" && typeof d.delta === "string") {
            const delta = d.delta;
            setMessages((prev) => updateLastAssistant(prev, (parts) => appendText(parts, delta)));
          }
          break;
        }
        case "tool_execution_start":
          if (!ev.toolCallId || !ev.toolName) break;
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
    [refreshState, refreshSessions],
  );

  // Auto-scroll on new content.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [messages]);

  // -- Actions -----------------------------------------------------------

  const executeSlashCommand = useCallback(async (raw: string) => {
    const command = raw.trim().split(/\s+/, 1)[0]?.toLowerCase();
    setError(null);
    setInput("");
    setSlashIndex(0);

    switch (command) {
      case "/help": {
        const lines = BASE_SLASH_COMMANDS.map((cmd) => `${cmd.name} — ${cmd.description}`);
        setMessages((prev) => [
          ...prev,
          { id: genId("a"), role: "assistant", parts: [{ kind: "text", text: lines.join("\n") }] },
        ]);
        return;
      }
      case "/new": {
        if (streaming) {
          setError("Cannot create a new session while the agent is streaming. Stop the run first.");
          return;
        }
        setMessages([]);
        const resp = await invoke<{ success: boolean; error?: string }>("rpc_call", {
          cmd: { type: "new_session" },
        });
        if (!resp.success) setError(resp.error ?? "new_session failed");
        await refreshState();
        return;
      }
      case "/clear":
        setMessages([]);
        if (activeTabId) tabMessagesRef.current.set(activeTabId, []);
        return;
      case "/refresh":
        await Promise.all([refreshState(), refreshSessions()]);
        return;
      case "/abort":
        await invoke("rpc_call", { cmd: { type: "abort" } });
        return;
      default:
        setError(`Unknown slash command: ${command ?? raw}`);
    }
  }, [activeTabId, refreshSessions, refreshState, streaming]);

  const send = useCallback(async () => {
    const text = input.trim();
    if (!text || streaming) return;
    if (text.startsWith("/")) {
      await executeSlashCommand(text);
      return;
    }
    setError(null);
    setInput("");
    setMessages((prev) => [...prev, { id: genId("u"), role: "user", text }]);
    try {
      const resp = await invoke<{ success: boolean; error?: string }>("rpc_call", {
        cmd: { type: "prompt", message: text },
      });
      if (!resp.success) setError(resp.error ?? "prompt rejected");
    } catch (e) {
      setError(String(e));
    }
  }, [executeSlashCommand, input, streaming]);

  const abort = useCallback(async () => {
    try {
      await invoke("rpc_call", { cmd: { type: "abort" } });
    } catch (e) {
      setError(String(e));
    }
  }, []);

  const newSession = useCallback(async () => {
    if (streaming) return;
    setError(null);
    // Note: actual new sessionFile will come back via the session_start event,
    // which triggers the openTabs/activeTabId sync effect below.
    setMessages([]);
    try {
      const resp = await invoke<{ success: boolean; error?: string }>("rpc_call", {
        cmd: { type: "new_session" },
      });
      if (!resp.success) setError(resp.error ?? "new_session failed");
      await refreshState();
    } catch (e) {
      setError(String(e));
    }
  }, [refreshState, streaming]);

  const switchSession = useCallback(async (path: string) => {
    if (streaming && path !== activeTabId) {
      setError("Cannot switch sessions while the agent is streaming. Stop the run first.");
      return;
    }
    setError(null);
    // Cache current messages under the previous active tab so switching back restores them.
    const prev = activeTabId;
    if (prev && prev !== path) {
      tabMessagesRef.current.set(prev, messagesRef.current);
    }
    setOpenTabs((tabs) => (tabs.includes(path) ? tabs : [...tabs, path]));
    setActiveTabId(path);
    const cached = tabMessagesRef.current.get(path);
    setMessages(cached ?? []);
    try {
      const resp = await invoke<{ success: boolean; error?: string }>("rpc_call", {
        cmd: { type: "switch_session", sessionPath: path },
      });
      if (!resp.success) {
        setError(resp.error ?? "switch_session failed");
        return;
      }
      await refreshState();
      if (!cached) await loadMessages(path);
    } catch (e) {
      setError(String(e));
    }
  }, [activeTabId, loadMessages, refreshState, streaming]);

  const closeTab = useCallback(
    async (path: string) => {
      if (streaming) {
        setError("Cannot close or switch tabs while the agent is streaming. Stop the run first.");
        return;
      }
      // Drop the closed tab; forget its cached messages.
      const next = openTabs.filter((p) => p !== path);
      tabMessagesRef.current.delete(path);
      setOpenTabs(next);
      // If we closed the active tab, switch to the next remaining one (or clear).
      if (activeTabId === path) {
        const newActive = next[next.length - 1] ?? null;
        setActiveTabId(newActive);
        if (newActive) {
          const cached = tabMessagesRef.current.get(newActive);
          setMessages(cached ?? []);
          try {
            await invoke("rpc_call", { cmd: { type: "switch_session", sessionPath: newActive } });
            await refreshState();
            if (!cached) await loadMessages(newActive);
          } catch (e) {
            setError(String(e));
          }
        } else {
          setMessages([]);
        }
      }
    },
    [openTabs, activeTabId, loadMessages, refreshState, streaming],
  );

  const slashQuery = input.startsWith("/") ? input.slice(1).trimStart().toLowerCase() : null;
  const slashCommands = BASE_SLASH_COMMANDS.map((cmd) => ({
    ...cmd,
    disabled:
      (cmd.name === "/new" && streaming) ||
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
        <div className="topbar">
          <div className="topbar__brand">
            <Sparkles size={16} className="topbar__logo" />
            <span>Pix Desktop</span>
          </div>
          <div className="topbar__workspace" title={workspace}>
            <FolderOpen size={12} />
            <span>{workspaceBasename(workspace)}</span>
          </div>
          <div className="topbar__actions">
            <button
              className="topbar__btn"
              onClick={() => void chooseFolder()}
              disabled={switchingWorkspace || streaming}
              title="Change folder"
            >
              switch
            </button>
            <button
              className="topbar__icon-btn"
              onClick={() => void refreshSessions()}
              disabled={loadingSessions}
              title="Refresh sessions"
              aria-label="Refresh sessions"
            >
              <RefreshCw size={13} className={loadingSessions ? "spinning" : ""} />
            </button>
            <button
              className="topbar__icon-btn"
              onClick={() => void newSession()}
              disabled={streaming}
              title="New session"
              aria-label="New session"
            >
              <Plus size={14} />
            </button>
          </div>
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
                    {sessionLabelFor(p, sessions, session)}
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

        <header className="chat__header">
          <div className="chat__title">
            {session.sessionName || (
              <span className="chat__title-placeholder">Untitled session</span>
            )}
          </div>
          <div className="chat__meta">
            {session.messageCount !== undefined && (
              <span title="Message count">{session.messageCount} msgs</span>
            )}
            {session.sessionFile && (
              <span className="chat__file" title={session.sessionFile}>
                {shortId(session.sessionId)}
              </span>
            )}
          </div>
        </header>

        <div className="chat__body" ref={scrollRef}>
          {messages.length === 0 ? (
            <div className="chat__empty">
              <Sparkles size={28} />
              <p>Send a message to start a conversation.</p>
              {session.messageCount && session.messageCount > 0 && loadingSessions ? (
                <p className="chat__empty-hint">
                  Loading {session.messageCount} saved messages…
                </p>
              ) : null}
            </div>
          ) : (
            messages.map((m) => <MessageView key={m.id} message={m} />)
          )}
          {error && (
            <div className="chat__error">
              <AlertCircle size={14} />
              <code>{error}</code>
            </div>
          )}
        </div>

        <footer className="composer">
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
                </button>
              ))}
            </div>
          )}
          <textarea
            className="composer__input"
            placeholder="Message Pix… (Shift+Enter for newline, / for commands)"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
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
                  if (cmd) setInput(cmd.name);
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
                if (slashMatches.length > 0) {
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
              className="composer__btn"
              onClick={send}
              disabled={!input.trim()}
              title="Send (Enter)"
              aria-label="Send"
            >
              <Send size={16} />
            </button>
          )}
        </footer>

        <StatusBar session={session} />
      </main>
    </div>
  );
}

// -- Status bar -----------------------------------------------------------

function StatusBar({ session }: { session: SessionState }) {
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
      {session.isCompacting && <span className="statusbar__item statusbar__compact">compacting…</span>}
    </div>
  );
}

// -- Tab helpers ---------------------------------------------------------

function sessionLabelFor(
  path: string,
  sessions: SessionSummary[],
  current: SessionState,
): string {
  if (current.sessionFile === path) {
    return current.sessionName ?? shortId(current.sessionId) ?? "Session";
  }
  const found = sessions.find((s) => s.path === path);
  if (found) {
    return found.name ?? truncate(found.firstMessage, 24) ?? "Untitled";
  }
  return shortId(path.split("/").pop() ?? path);
}

// -- Helpers --------------------------------------------------------------

function MessageView({ message }: { message: ChatMessage }) {
  return (
    <div className={`msg msg--${message.role}`}>
      <div className="msg__avatar">
        {message.role === "user" ? <User size={14} /> : <Bot size={14} />}
      </div>
      <div className="msg__body">
        {message.role === "user" ? (
          <div className="msg__text">{message.text}</div>
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
  for (const m of history) {
    if (m.role === "user") {
      const text = contentToText(m.content);
      if (text) out.push({ id: genId("u"), role: "user", text });
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
      if (parts.length > 0) out.push({ id: genId("a"), role: "assistant", parts });
      continue;
    }

    if (m.role === "toolResult" && typeof m.toolCallId === "string") {
      const result = m.details ?? contentToText(m.content) ?? undefined;
      const updated = updateToolResult(out, m.toolCallId, result, Boolean(m.isError));
      const toolName = typeof m.toolName === "string" ? m.toolName : undefined;
      if (!updated && toolName) {
        out.push({
          id: genId("a"),
          role: "assistant",
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

function readPersistedTabs(workspace: string): PersistedTabs {
  try {
    const raw = localStorage.getItem(tabsStorageKey(workspace));
    if (!raw) return { openTabs: [], activeTabId: null };
    const parsed = JSON.parse(raw) as Partial<PersistedTabs>;
    const openTabs = uniqueStrings(
      Array.isArray(parsed.openTabs)
        ? parsed.openTabs.filter((p): p is string => typeof p === "string" && p.length > 0)
        : [],
    );
    const activeTabId = typeof parsed.activeTabId === "string" && openTabs.includes(parsed.activeTabId)
      ? parsed.activeTabId
      : null;
    return { openTabs, activeTabId };
  } catch {
    return { openTabs: [], activeTabId: null };
  }
}

function writePersistedTabs(workspace: string, tabs: PersistedTabs): void {
  try {
    const openTabs = uniqueStrings(tabs.openTabs);
    const activeTabId = tabs.activeTabId && openTabs.includes(tabs.activeTabId)
      ? tabs.activeTabId
      : null;
    localStorage.setItem(tabsStorageKey(workspace), JSON.stringify({ openTabs, activeTabId }));
  } catch {
    // localStorage may be unavailable in tests or restricted webviews.
  }
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values.filter((value) => value.length > 0)));
}
