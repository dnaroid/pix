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
  Pencil,
  Check,
  X,
  FolderOpen,
} from "lucide-react";
import { lookup, defaultRenderer } from "./tools";
import type { ToolRenderProps } from "./tools/types";
import "./App.css";

const WORKSPACE_KEY = "pix-desktop.workspace";

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
};

let nextId = 0;
const genId = (prefix: string) => `${prefix}-${++nextId}`;

// -- Component ------------------------------------------------------------

export default function App() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [session, setSession] = useState<SessionState>({});
  const [editingPath, setEditingPath] = useState<string | null>(null);
  const [editingName, setEditingName] = useState("");
  const [loadingSessions, setLoadingSessions] = useState(false);
  const [workspace, setWorkspace] = useState<string | null>(() => {
    try {
      return localStorage.getItem(WORKSPACE_KEY);
    } catch {
      return null;
    }
  });
  const [switchingWorkspace, setSwitchingWorkspace] = useState(false);
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
      setWorkspace(newCwd);
      setMessages([]);
      setSession({});
      return newCwd;
    } catch (e) {
      setError(`choose folder: ${String(e)}`);
      return null;
    } finally {
      setSwitchingWorkspace(false);
    }
  }, []);

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
    void invoke<{ success: boolean; error?: string }>("set_workspace", { path: workspace })
      .then((resp) => {
        if (!resp.success) {
          // Saved workspace is no longer accessible — drop it and let the
          // user re-pick.
          try { localStorage.removeItem(WORKSPACE_KEY); } catch { /* ignore */ }
          setWorkspace(null);
          setError(`workspace '${workspace}' unavailable: ${resp.error ?? "?"}`);
        }
      })
      .catch((e) => setError(`restore workspace: ${String(e)}`));
  }, [workspace]);

  // Refresh sessions whenever workspace changes (or on initial mount).
  useEffect(() => {
    if (workspace) void refreshSessions();
  }, [workspace, refreshSessions]);

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

  const send = useCallback(async () => {
    const text = input.trim();
    if (!text || streaming) return;
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
  }, [input, streaming]);

  const abort = useCallback(async () => {
    try {
      await invoke("rpc_call", { cmd: { type: "abort" } });
    } catch (e) {
      setError(String(e));
    }
  }, []);

  const newSession = useCallback(async () => {
    setError(null);
    setMessages([]);
    try {
      const resp = await invoke<{ success: boolean; error?: string }>("rpc_call", {
        cmd: { type: "new_session" },
      });
      if (!resp.success) setError(resp.error ?? "new_session failed");
      // session_start event will fire and trigger refresh
    } catch (e) {
      setError(String(e));
    }
  }, []);

  const switchSession = useCallback(async (path: string) => {
    setError(null);
    setMessages([]);
    try {
      const resp = await invoke<{ success: boolean; error?: string }>("rpc_call", {
        cmd: { type: "switch_session", sessionPath: path },
      });
      if (!resp.success) setError(resp.error ?? "switch_session failed");
    } catch (e) {
      setError(String(e));
    }
  }, []);

  const saveRename = useCallback(
    async (path: string) => {
      const name = editingName.trim();
      setEditingPath(null);
      if (!name) return;
      try {
        // Switch to that session first, rename, then switch back if different.
        const wasCurrent = session.sessionFile === path;
        if (!wasCurrent) {
          await invoke("rpc_call", { cmd: { type: "switch_session", sessionPath: path } });
        }
        await invoke("rpc_call", { cmd: { type: "set_session_name", name } });
        if (!wasCurrent) {
          // session_info_changed will refresh; if we were on a different session,
          // we need to switch back. The handler will pick up the new state.
          // (We don't know our previous path here reliably; rely on refreshState.)
        }
        void refreshSessions();
      } catch (e) {
        setError(String(e));
      }
    },
    [editingName, session.sessionFile, refreshSessions],
  );

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
      <aside className="sidebar">
        <div className="sidebar__head">
          <Sparkles size={16} className="sidebar__logo" />
          <span className="sidebar__title">Pix Desktop</span>
          <button
            className="sidebar__btn"
            onClick={newSession}
            disabled={streaming}
            title="New session"
            aria-label="New session"
          >
            <Plus size={14} />
          </button>
          <button
            className="sidebar__btn"
            onClick={refreshSessions}
            disabled={loadingSessions}
            title="Refresh"
            aria-label="Refresh sessions"
          >
            <RefreshCw size={13} className={loadingSessions ? "spinning" : ""} />
          </button>
        </div>
        <div className="sidebar__workspace" title={workspace}>
          <FolderOpen size={12} />
          <span className="sidebar__workspace-path">{workspaceBasename(workspace)}</span>
          <button
            className="sidebar__workspace-btn"
            onClick={() => void chooseFolder()}
            disabled={switchingWorkspace || streaming}
            title="Change folder"
            aria-label="Change folder"
          >
            switch
          </button>
        </div>
        <div className="sidebar__list">
          {sessions.length === 0 && !loadingSessions && (
            <div className="sidebar__empty">No sessions yet</div>
          )}
          {sessions.map((s) => (
            <SessionItem
              key={s.path}
              s={s}
              active={s.path === session.sessionFile}
              editing={editingPath === s.path}
              editValue={editingPath === s.path ? editingName : ""}
              onEditStart={() => {
                setEditingPath(s.path);
                setEditingName(s.name ?? "");
              }}
              onEditChange={setEditingName}
              onEditCancel={() => setEditingPath(null)}
              onEditSave={() => void saveRename(s.path)}
              onSwitch={() => void switchSession(s.path)}
            />
          ))}
        </div>
      </aside>

      <main className="chat">
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
              {session.messageCount && session.messageCount > 0 ? (
                <p className="chat__empty-hint">
                  ({session.messageCount} messages in this session — load history in Phase 3)
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
          <textarea
            className="composer__input"
            placeholder="Message Pix… (Shift+Enter for newline)"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
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
      </main>
    </div>
  );
}

// -- Session item ---------------------------------------------------------

function SessionItem(props: {
  s: SessionSummary;
  active: boolean;
  editing: boolean;
  editValue: string;
  onEditStart: () => void;
  onEditChange: (v: string) => void;
  onEditCancel: () => void;
  onEditSave: () => void;
  onSwitch: () => void;
}) {
  const { s, active, editing, editValue, onEditStart, onEditChange, onEditCancel, onEditSave, onSwitch } = props;
  const label = s.name ?? truncate(s.firstMessage, 40) ?? "Untitled";
  return (
    <div
      className={`session-item ${active ? "session-item--active" : ""}`}
      onClick={editing ? undefined : onSwitch}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (!editing && (e.key === "Enter" || e.key === " ")) {
          e.preventDefault();
          onSwitch();
        }
      }}
    >
      <div className="session-item__main">
        {editing ? (
          <input
            className="session-item__input"
            autoFocus
            value={editValue}
            onChange={(e) => onEditChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                onEditSave();
              } else if (e.key === "Escape") {
                e.preventDefault();
                onEditCancel();
              }
            }}
            onClick={(e) => e.stopPropagation()}
          />
        ) : (
          <div className="session-item__label" title={label}>
            {label}
          </div>
        )}
        <div className="session-item__meta">
          <span>{s.messageCount} msgs</span>
          <span>·</span>
          <span>{relativeTime(new Date(s.modified))}</span>
        </div>
      </div>
      {!editing && (
        <button
          className="session-item__rename"
          onClick={(e) => {
            e.stopPropagation();
            onEditStart();
          }}
          title="Rename"
          aria-label="Rename session"
        >
          <Pencil size={11} />
        </button>
      )}
      {editing && (
        <div className="session-item__actions">
          <button
            className="session-item__rename"
            onClick={(e) => {
              e.stopPropagation();
              onEditSave();
            }}
            title="Save"
          >
            <Check size={11} />
          </button>
          <button
            className="session-item__rename"
            onClick={(e) => {
              e.stopPropagation();
              onEditCancel();
            }}
            title="Cancel"
          >
            <X size={11} />
          </button>
        </div>
      )}
    </div>
  );
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

function relativeTime(date: Date): string {
  const diff = Date.now() - date.getTime();
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  return date.toLocaleDateString();
}
