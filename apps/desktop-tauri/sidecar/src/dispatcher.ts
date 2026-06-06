/**
 * RPC dispatcher.
 *
 * Reads JSONL commands from stdin, dispatches each to a handler, and writes
 * responses/events to stdout. Mirrors the SDK's `runRpcMode` shape plus a
 * `pix:*` namespace for desktop-only commands (see `pix-handlers.ts`).
 *
 * Why not use `runRpcMode` directly? It owns stdin and has no extension hook
 * for custom commands. We need pix:list_sessions / pix:set_cwd etc. for the
 * desktop UI, so we reimplement the protocol here against the public
 * AgentSession / AgentSessionRuntime APIs.
 */

import type {
  AgentSessionRuntime,
  AgentSession,
  ExtensionUIContext,
  ExtensionWidgetOptions,
} from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import {
  attachJsonlLineReader,
  serializeJsonLine,
} from "./framing.js";
import { listSessions } from "./pix-handlers.js";
import {
  sessionHistoryDisplayMessages,
  sessionHistoryOlderMessagesReader,
  type SessionHistoryOlderMessagesReader,
} from "./session-history.js";
import type { RpcEvent, RpcResponse, UnknownCommand } from "./protocol.js";

export type DispatcherOptions = {
  initialRuntime: AgentSessionRuntime;
  /**
   * Replace the active runtime with one scoped to a new cwd. Called by the
   * `pix:set_cwd` handler. The returned runtime becomes the dispatcher's
   * active runtime for subsequent commands and event subscription.
   */
  switchCwd?: (newCwd: string) => Promise<AgentSessionRuntime>;
  /** Replace the active runtime with a specific persisted session file. */
  switchSession?: (sessionPath: string) => Promise<AgentSessionRuntime>;
  /** Called once on startup and again whenever the runtime replaces the session. */
  onSession: (session: AgentSession, output: (ev: RpcEvent) => void) => () => void;
};

/** Write a value to stdout as a single JSONL record. */
function writeLine(value: RpcResponse | RpcEvent): void {
  process.stdout.write(serializeJsonLine(value));
}

export function success(id: string | undefined, command: string, data?: unknown): RpcResponse {
  return data === undefined
    ? { id, type: "response", command, success: true }
    : { id, type: "response", command, success: true, data };
}

export function failure(id: string | undefined, command: string, error: string): RpcResponse {
  return { id, type: "response", command, success: false, error };
}

/** Run the dispatcher until stdin closes or the process is signalled. */
export async function runDispatcher(opts: DispatcherOptions): Promise<void> {
  // Holder for the active runtime — `pix:set_cwd` swaps it via opts.switchCwd.
  const holder: { runtime: AgentSessionRuntime } = { runtime: opts.initialRuntime };
  let unsubscribe: (() => void) | undefined;
  let olderHistoryReaderKey: string | undefined;
  let olderHistoryReader: SessionHistoryOlderMessagesReader | undefined;
  const pendingExtensionRequests = new Map<
    string,
    { resolve: (response: UnknownCommand) => void; reject: (error: unknown) => void }
  >();

  const getOlderHistoryReader = (session: AgentSession): SessionHistoryOlderMessagesReader | undefined => {
    const key = session.sessionFile ?? session.sessionId;
    if (olderHistoryReaderKey !== key) {
      olderHistoryReaderKey = key;
      olderHistoryReader = sessionHistoryOlderMessagesReader(session);
    }
    return olderHistoryReader;
  };

  const createDialogPromise = <T>(
    opts: { timeout?: number; signal?: AbortSignal } | undefined,
    defaultValue: T,
    request: Record<string, unknown>,
    parseResponse: (response: UnknownCommand) => T,
  ): Promise<T> => {
    if (opts?.signal?.aborted) return Promise.resolve(defaultValue);
    const requestId = randomUUID();
    return new Promise<T>((resolve, reject) => {
      let timeoutId: ReturnType<typeof setTimeout> | undefined;
      const cleanup = () => {
        if (timeoutId) clearTimeout(timeoutId);
        opts?.signal?.removeEventListener("abort", onAbort);
        pendingExtensionRequests.delete(requestId);
      };
      const onAbort = () => {
        cleanup();
        resolve(defaultValue);
      };
      opts?.signal?.addEventListener("abort", onAbort, { once: true });
      if (opts?.timeout) {
        timeoutId = setTimeout(() => {
          cleanup();
          resolve(defaultValue);
        }, opts.timeout);
      }
      pendingExtensionRequests.set(requestId, {
        resolve: (response) => {
          cleanup();
          resolve(parseResponse(response));
        },
        reject,
      });
      writeLine({ type: "extension_ui_request", id: requestId, ...request });
    });
  };

  const createExtensionUIContext = (): ExtensionUIContext => ({
    select: (title, options, dialogOpts) =>
      createDialogPromise(dialogOpts, undefined, { method: "select", title, options, timeout: dialogOpts?.timeout }, (response) =>
        response.cancelled ? undefined : typeof response.value === "string" ? response.value : undefined,
      ),
    confirm: (title, message, dialogOpts) =>
      createDialogPromise(dialogOpts, false, { method: "confirm", title, message, timeout: dialogOpts?.timeout }, (response) =>
        response.cancelled ? false : response.confirmed === true,
      ),
    input: (title, placeholder, dialogOpts) =>
      createDialogPromise(dialogOpts, undefined, { method: "input", title, placeholder, timeout: dialogOpts?.timeout }, (response) =>
        response.cancelled ? undefined : typeof response.value === "string" ? response.value : undefined,
      ),
    notify(message, type) {
      writeLine({ type: "extension_ui_request", id: randomUUID(), method: "notify", message, notifyType: type });
    },
    onTerminalInput() {
      return () => {};
    },
    setStatus(key, text) {
      writeLine({ type: "extension_ui_request", id: randomUUID(), method: "setStatus", statusKey: key, statusText: text });
    },
    setWorkingMessage() {},
    setWorkingVisible() {},
    setWorkingIndicator() {},
    setHiddenThinkingLabel() {},
    setWidget(key, content, options?: ExtensionWidgetOptions) {
      if (content === undefined || Array.isArray(content)) {
        writeLine({
          type: "extension_ui_request",
          id: randomUUID(),
          method: "setWidget",
          widgetKey: key,
          widgetLines: content,
          widgetPlacement: options?.placement,
        });
      }
    },
    setFooter() {},
    setHeader() {},
    setTitle(title) {
      writeLine({ type: "extension_ui_request", id: randomUUID(), method: "setTitle", title });
    },
    async custom<T>() {
      return undefined as T;
    },
    pasteToEditor(text) {
      this.setEditorText(text);
    },
    setEditorText(text) {
      writeLine({ type: "extension_ui_request", id: randomUUID(), method: "set_editor_text", text });
    },
    getEditorText() {
      return "";
    },
    editor: (title, prefill) =>
      createDialogPromise(undefined, undefined, { method: "editor", title, prefill }, (response) =>
        response.cancelled ? undefined : typeof response.value === "string" ? response.value : undefined,
      ),
    addAutocompleteProvider() {},
    setEditorComponent() {},
    getEditorComponent() {
      return undefined;
    },
    get theme() {
      return undefined as unknown as ExtensionUIContext["theme"];
    },
    getAllThemes() {
      return [];
    },
    getTheme() {
      return undefined;
    },
    setTheme() {
      return { success: false, error: "Theme switching is not supported in Pix Desktop sidecar mode" };
    },
    getToolsExpanded() {
      return false;
    },
    setToolsExpanded() {},
  });

  const rebindSession = async (): Promise<void> => {
    unsubscribe?.();
    olderHistoryReaderKey = undefined;
    olderHistoryReader = undefined;
    const session = holder.runtime.session;
    await session.bindExtensions({
      uiContext: createExtensionUIContext(),
      commandContextActions: {
        waitForIdle: () => session.agent.waitForIdle(),
        newSession: async (options) => holder.runtime.newSession(options),
        fork: async (entryId, options) => {
          const result = await holder.runtime.fork(entryId, options);
          return { cancelled: result.cancelled };
        },
        navigateTree: async (targetId, options) => {
          const result = await session.navigateTree(targetId, {
            summarize: options?.summarize,
            customInstructions: options?.customInstructions,
            replaceInstructions: options?.replaceInstructions,
            label: options?.label,
          });
          return { cancelled: result.cancelled };
        },
        switchSession: async (sessionPath, options) => holder.runtime.switchSession(sessionPath, options),
        reload: async () => {
          await session.reload();
        },
      },
      shutdownHandler: () => process.exit(0),
      onError: (err) => {
        writeLine({ type: "extension_error", extensionPath: err.extensionPath, event: err.event, error: err.error });
      },
    });
    unsubscribe = opts.onSession(holder.runtime.session, (ev) => writeLine(ev));
  };

  await rebindSession();

  const handleCommand = async (raw: UnknownCommand): Promise<void> => {
    const id = typeof raw.id === "string" ? raw.id : undefined;
    const session = holder.runtime.session;

    try {
      switch (raw.type) {
        // -- Prompting ----------------------------------------------------
        case "prompt": {
          const message = typeof raw.message === "string" ? raw.message : "";
          const images = Array.isArray(raw.images) ? normalizeImages(raw.images) : undefined;
          // The SDK's prompt() resolves only after the full run; we emit the
          // success response eagerly once preflight accepts the prompt, then
          // let subsequent events stream. Rejections before preflight surface
          // as failure; failures after preflight come through the event bus.
          let preflightSucceeded = false;
          void session
            .prompt(message, {
              streamingBehavior:
                raw.streamingBehavior === "steer" || raw.streamingBehavior === "followUp"
                  ? raw.streamingBehavior
                  : undefined,
              images,
              source: "rpc",
              preflightResult: (ok: boolean) => {
                if (ok) {
                  preflightSucceeded = true;
                  writeLine(success(id, "prompt"));
                }
              },
            })
            .catch((e: unknown) => {
              if (!preflightSucceeded) {
                writeLine(failure(id, "prompt", errorMessage(e)));
              }
            });
          return;
        }
        case "abort": {
          await session.abort();
          writeLine(success(id, "abort"));
          return;
        }

        // -- State --------------------------------------------------------
        case "get_state": {
          const state = {
            model: session.model,
            thinkingLevel: session.thinkingLevel,
            isStreaming: session.isStreaming,
            isCompacting: session.isCompacting,
            steeringMode: session.steeringMode,
            followUpMode: session.followUpMode,
            sessionFile: session.sessionFile,
            sessionId: session.sessionId,
            sessionName: session.sessionName,
            autoCompactionEnabled: session.autoCompactionEnabled,
            messageCount: session.messages.length,
            pendingMessageCount: session.pendingMessageCount,
            contextUsage: session.getContextUsage(),
          };
          writeLine(success(id, "get_state", state));
          return;
        }
        case "get_messages": {
          const historyMessages = sessionHistoryDisplayMessages(session);
          const olderReader = getOlderHistoryReader(session);
          const total = historyMessages.length;
          const requestedLimit = typeof raw.limit === "number" && Number.isFinite(raw.limit)
            ? Math.max(0, Math.floor(raw.limit))
            : undefined;
          const limit = requestedLimit === undefined ? total : requestedLimit;
          const requestedOffset = typeof raw.offset === "number" && Number.isFinite(raw.offset)
            ? Math.floor(raw.offset)
            : undefined;

          if (raw.lazyOlder === true && olderReader?.hasOlder()) {
            const messages = await olderReader.readOlder(limit);
            writeLine(success(id, "get_messages", {
              messages,
              offset: 0,
              total,
              hasOlder: olderReader.hasOlder(),
            }));
            return;
          }

          if (raw.lazyOlder === true) {
            writeLine(success(id, "get_messages", {
              messages: [],
              offset: 0,
              total,
              hasOlder: false,
            }));
            return;
          }

          const offset = raw.fromEnd
            ? Math.max(0, total - limit)
            : Math.min(Math.max(0, requestedOffset ?? 0), total);
          let messages = historyMessages.slice(offset, Math.min(total, offset + limit));

          // Long sessions can end with mostly non-display session entries
          // (labels/session_info/custom bookkeeping/tool results without the
          // visible call in the same tail). In that case the initial tail page
          // would be empty even though the session has visible chat history.
          // Fill the first tail page from older entries until it has displayable
          // messages, mirroring the TUI lazy history loader behavior.
          if (raw.fromEnd === true && offset === 0 && messages.length < limit && olderReader?.hasOlder()) {
            const older = await olderReader.readOlder(limit - messages.length);
            messages = [...older, ...messages];
          }

          writeLine(success(id, "get_messages", {
            messages,
            offset,
            total,
            hasOlder: olderReader?.hasOlder() === true,
          }));
          return;
        }
        case "get_session_stats": {
          const stats = session.getSessionStats();
          writeLine(success(id, "get_session_stats", stats));
          return;
        }
        case "get_commands": {
          const commands = [];
          for (const command of session.extensionRunner.getRegisteredCommands()) {
            commands.push({
              name: command.invocationName,
              description: command.description,
              source: "extension",
              sourceInfo: command.sourceInfo,
            });
          }
          for (const template of session.promptTemplates) {
            commands.push({
              name: template.name,
              description: template.description,
              source: "prompt",
              sourceInfo: template.sourceInfo,
            });
          }
          for (const skill of session.resourceLoader.getSkills().skills) {
            commands.push({
              name: `skill:${skill.name}`,
              description: skill.description,
              source: "skill",
              sourceInfo: skill.sourceInfo,
            });
          }
          writeLine(success(id, "get_commands", { commands }));
          return;
        }
        case "get_command_completions": {
          const commandName = typeof raw.command === "string" ? raw.command.replace(/^\/+/, "") : "";
          const argumentPrefix = typeof raw.argumentPrefix === "string" ? raw.argumentPrefix : "";
          if (!commandName) {
            writeLine(failure(id, "get_command_completions", "command required"));
            return;
          }
          const command = session.extensionRunner
            .getRegisteredCommands()
            .find((candidate) => candidate.invocationName.replace(/^\/+/, "") === commandName);
          if (!command?.getArgumentCompletions) {
            writeLine(success(id, "get_command_completions", { completions: [] }));
            return;
          }
          const items = await command.getArgumentCompletions(argumentPrefix);
          writeLine(success(id, "get_command_completions", { completions: normalizeCompletions(items) }));
          return;
        }
        case "extension_ui_response": {
          if (!id) {
            writeLine(failure(id, "extension_ui_response", "id required"));
            return;
          }
          const pending = pendingExtensionRequests.get(id);
          if (!pending) {
            writeLine(failure(id, "extension_ui_response", "No pending extension UI request for id"));
            return;
          }
          pending.resolve(raw);
          writeLine(success(id, "extension_ui_response"));
          return;
        }
        case "get_models": {
          const current = session.model;
          const available = holder.runtime.services.modelRegistry.getAvailable();
          writeLine(success(id, "get_models", {
            models: available.map((model) => summarizeModel(model, current)),
          }));
          return;
        }
        case "set_model": {
          const ref = typeof raw.ref === "string" ? raw.ref.trim() : "";
          const provider = typeof raw.provider === "string" ? raw.provider.trim() : "";
          const modelId = typeof raw.modelId === "string" ? raw.modelId.trim() : "";
          const model = findModel(holder.runtime.services.modelRegistry.getAvailable(), { ref, provider, modelId });
          if (!model) {
            writeLine(failure(id, "set_model", "Model not found or unavailable"));
            return;
          }
          await session.setModel(model as Parameters<typeof session.setModel>[0]);
          writeLine(success(id, "set_model", { model: summarizeModel(model, session.model) }));
          return;
        }
        case "compact": {
          const instructions = typeof raw.instructions === "string" && raw.instructions.trim()
            ? raw.instructions.trim()
            : undefined;
          const result = await session.compact(instructions);
          writeLine(success(id, "compact", { result, contextUsage: session.getContextUsage() }));
          return;
        }
        case "undo_last_turn": {
          const userMessages = session.getUserMessagesForForking();
          const last = userMessages[userMessages.length - 1];
          if (!last) {
            writeLine(failure(id, "undo_last_turn", "No user message to undo"));
            return;
          }
          const result = await session.navigateTree(last.entryId, { summarize: false });
          writeLine(success(id, "undo_last_turn", { ...result, target: last }));
          return;
        }

        // -- Session lifecycle -------------------------------------------
        case "new_session": {
          const options =
            typeof raw.parentSession === "string" ? { parentSession: raw.parentSession } : undefined;
          const result = await holder.runtime.newSession(options);
          if (!result.cancelled) await rebindSession();
          writeLine(success(id, "new_session", result));
          return;
        }
        case "switch_session": {
          const sessionPath = typeof raw.sessionPath === "string" ? raw.sessionPath : "";
          if (!sessionPath) {
            writeLine(failure(id, "switch_session", "sessionPath required"));
            return;
          }
          if (opts.switchSession) {
            holder.runtime = await opts.switchSession(sessionPath);
            await rebindSession();
            writeLine(success(id, "switch_session", { cancelled: false }));
            return;
          }
          const result = await holder.runtime.switchSession(sessionPath);
          if (!result.cancelled) await rebindSession();
          writeLine(success(id, "switch_session", result));
          return;
        }
        case "set_session_name": {
          const name = typeof raw.name === "string" ? raw.name.trim() : "";
          if (!name) {
            writeLine(failure(id, "set_session_name", "Session name cannot be empty"));
            return;
          }
          session.setSessionName(name);
          writeLine(success(id, "set_session_name"));
          return;
        }

        // -- Pix desktop extensions --------------------------------------
        case "pix:list_sessions": {
          const data = await listSessions(holder.runtime);
          writeLine(success(id, "pix:list_sessions", data));
          return;
        }
        case "pix:set_cwd": {
          if (!opts.switchCwd) {
            writeLine(failure(id, "pix:set_cwd", "switchCwd not configured"));
            return;
          }
          const newCwd = typeof raw.cwd === "string" ? raw.cwd.trim() : "";
          if (!newCwd) {
            writeLine(failure(id, "pix:set_cwd", "cwd required"));
            return;
          }
          const newRuntime = await opts.switchCwd(newCwd);
          holder.runtime = newRuntime;
          await rebindSession();
          writeLine(
            success(id, "pix:set_cwd", {
              cwd: newRuntime.cwd,
              sessionId: newRuntime.session.sessionId,
              sessionFile: newRuntime.session.sessionFile,
            }),
          );
          return;
        }

        default: {
          writeLine(failure(id, (raw as UnknownCommand).type, `Unknown command: ${(raw as UnknownCommand).type}`));
        }
      }
    } catch (e: unknown) {
      // Ensure every command path eventually produces a response on failure.
      const command = (raw as UnknownCommand).type ?? "unknown";
      writeLine(failure(id, command, errorMessage(e)));
    }
  };

  const onLine = (line: string): void => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (e) {
      writeLine(failure(undefined, "parse", `Failed to parse command: ${errorMessage(e)}`));
      return;
    }
    if (typeof parsed !== "object" || parsed === null || !("type" in parsed)) {
      writeLine(failure(undefined, "parse", "Command must be an object with `type`"));
      return;
    }
    void handleCommand(parsed as UnknownCommand);
  };

  const detach = attachJsonlLineReader(process.stdin, onLine);

  await new Promise<void>((resolve) => {
    process.stdin.once("end", () => {
      unsubscribe?.();
      detach();
      resolve();
    });
  });
}

function normalizeImages(images: unknown[]): { type: "image"; data: string; mimeType: string }[] | undefined {
  const normalized = images
    .map((image) => {
      if (!image || typeof image !== "object") return null;
      const candidate = image as Record<string, unknown>;
      const data = typeof candidate.data === "string" ? candidate.data : "";
      const mimeType = typeof candidate.mimeType === "string" ? candidate.mimeType : "";
      if (!data || !mimeType.startsWith("image/")) return null;
      return { type: "image" as const, data, mimeType };
    })
    .filter((image): image is { type: "image"; data: string; mimeType: string } => image !== null);
  return normalized.length > 0 ? normalized : undefined;
}

function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

function normalizeCompletions(items: unknown): Array<{ label: string; value: string; description?: string }> {
  if (!Array.isArray(items)) return [];
  const completions: Array<{ label: string; value: string; description?: string }> = [];
  for (const item of items) {
    if (typeof item === "string") {
      if (item) completions.push({ label: item, value: item });
      continue;
    }
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const value = firstString(record.insertText, record.value, record.label, record.text, record.name);
    if (!value) continue;
    const label = firstString(record.label, record.text, record.name, record.value, record.insertText) ?? value;
    const description = firstString(record.description, record.detail, record.documentation);
    completions.push(description ? { label, value, description } : { label, value });
  }
  return completions;
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value;
  }
  return undefined;
}

type ModelLike = {
  id: string;
  name: string;
  provider: string;
  reasoning?: boolean;
  contextWindow?: number;
};

function summarizeModel(model: ModelLike, current: ModelLike | undefined): Record<string, unknown> {
  return {
    id: model.id,
    name: model.name,
    provider: model.provider,
    ref: `${model.provider}/${model.id}`,
    reasoning: model.reasoning === true,
    contextWindow: model.contextWindow,
    current: Boolean(current && current.provider === model.provider && current.id === model.id),
  };
}

function findModel(models: ModelLike[], target: { ref?: string; provider?: string; modelId?: string }): ModelLike | undefined {
  const ref = target.ref?.toLowerCase();
  if (ref) {
    return models.find((model) => {
      const fullRef = `${model.provider}/${model.id}`.toLowerCase();
      return fullRef === ref || model.id.toLowerCase() === ref || model.name.toLowerCase() === ref;
    });
  }
  const provider = target.provider?.toLowerCase();
  const modelId = target.modelId?.toLowerCase();
  if (!provider || !modelId) return undefined;
  return models.find((model) => model.provider.toLowerCase() === provider && model.id.toLowerCase() === modelId);
}
