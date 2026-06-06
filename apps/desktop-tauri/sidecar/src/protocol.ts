/**
 * Wire types for the Pix Desktop sidecar RPC dispatcher.
 *
 * The dispatcher speaks the SDK's native RPC protocol
 * (node_modules/@earendil-works/pi-coding-agent/docs/rpc.md) plus a small
 * `pix:*` namespace for desktop-only commands that have no SDK equivalent.
 *
 * Wire shape on stdout is JSONL: one JSON object per `\n`. We do NOT use
 * JSON-RPC 2.0 (no `jsonrpc` field, no `method`/`params`); the SDK uses a
 * flatter `{id, type, ...}` shape and we follow that.
 */

/** RPC response shape on stdout. */
export type RpcResponse =
  | { id?: string; type: "response"; command: string; success: true }
  | { id?: string; type: "response"; command: string; success: true; data: unknown }
  | { id?: string; type: "response"; command: string; success: false; error: string };

/** Generic RPC event streamed from the agent. */
export type RpcEvent = { type: string; [k: string]: unknown };

/** RPC command on stdin (subset we support in Phase 2 + pix:* namespace). */
export type RpcCommand =
  // -- Prompting --------------------------------------------------------
  | { id?: string; type: "prompt"; message: string; images?: unknown[]; streamingBehavior?: "steer" | "followUp" }
  | { id?: string; type: "abort" }
  // -- State ------------------------------------------------------------
  | { id?: string; type: "get_state" }
  | { id?: string; type: "get_messages" }
  | { id?: string; type: "get_session_stats" }
  // -- Session lifecycle ------------------------------------------------
  | { id?: string; type: "new_session"; parentSession?: string }
  | { id?: string; type: "switch_session"; sessionPath: string }
  | { id?: string; type: "set_session_name"; name: string }
  // -- Pix desktop extensions -------------------------------------------
  | { id?: string; type: "pix:list_sessions" }
  | { id?: string; type: "pix:set_cwd"; cwd: string };

/** A command we received but don't recognize. We still need a type for it. */
export type UnknownCommand = { id?: string; type: string; [k: string]: unknown };
