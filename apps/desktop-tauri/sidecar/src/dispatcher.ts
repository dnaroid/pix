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
} from "@earendil-works/pi-coding-agent";
import {
  attachJsonlLineReader,
  serializeJsonLine,
} from "./framing.js";
import { listSessions } from "./pix-handlers.js";
import type { RpcEvent, RpcResponse, UnknownCommand } from "./protocol.js";

export type DispatcherOptions = {
  initialRuntime: AgentSessionRuntime;
  /**
   * Replace the active runtime with one scoped to a new cwd. Called by the
   * `pix:set_cwd` handler. The returned runtime becomes the dispatcher's
   * active runtime for subsequent commands and event subscription.
   */
  switchCwd?: (newCwd: string) => Promise<AgentSessionRuntime>;
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

  const rebindSession = (): void => {
    unsubscribe?.();
    unsubscribe = opts.onSession(holder.runtime.session, (ev) => writeLine(ev));
  };

  rebindSession();

  const handleCommand = async (raw: UnknownCommand): Promise<void> => {
    const id = typeof raw.id === "string" ? raw.id : undefined;
    const session = holder.runtime.session;

    try {
      switch (raw.type) {
        // -- Prompting ----------------------------------------------------
        case "prompt": {
          const message = typeof raw.message === "string" ? raw.message : "";
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
              // images and source are SDK-internal; we don't expose them yet.
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
          writeLine(success(id, "get_messages", { messages: session.messages }));
          return;
        }
        case "get_session_stats": {
          const stats = session.getSessionStats();
          writeLine(success(id, "get_session_stats", stats));
          return;
        }

        // -- Session lifecycle -------------------------------------------
        case "new_session": {
          const options =
            typeof raw.parentSession === "string" ? { parentSession: raw.parentSession } : undefined;
          const result = await holder.runtime.newSession(options);
          if (!result.cancelled) rebindSession();
          writeLine(success(id, "new_session", result));
          return;
        }
        case "switch_session": {
          const sessionPath = typeof raw.sessionPath === "string" ? raw.sessionPath : "";
          if (!sessionPath) {
            writeLine(failure(id, "switch_session", "sessionPath required"));
            return;
          }
          const result = await holder.runtime.switchSession(sessionPath);
          if (!result.cancelled) rebindSession();
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
          rebindSession();
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

function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}
