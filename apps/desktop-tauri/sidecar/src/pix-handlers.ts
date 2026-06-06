/**
 * Pix Desktop custom RPC commands.
 *
 * These extend the SDK's native RPC protocol with desktop-only operations
 * that have no equivalent in `runRpcMode` — currently just session listing
 * (which uses the static `SessionManager.list(cwd)` API) and cwd switching
 * (which rebuilds the runtime against a new working directory).
 */

import type { AgentSessionRuntime } from "@earendil-works/pi-coding-agent";
import { SessionManager } from "@earendil-works/pi-coding-agent";

/** Serializable subset of SessionInfo. Dates become ISO strings. */
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

function summarize(info: Awaited<ReturnType<typeof SessionManager.list>>[number]): SessionSummary {
  return {
    path: info.path,
    id: info.id,
    cwd: info.cwd,
    name: info.name,
    parentSessionPath: info.parentSessionPath,
    created: info.created.toISOString(),
    modified: info.modified.toISOString(),
    messageCount: info.messageCount,
    firstMessage: info.firstMessage,
  };
}

/** pix:list_sessions — list all sessions for the runtime's cwd. */
export async function listSessions(runtime: AgentSessionRuntime): Promise<{ sessions: SessionSummary[] }> {
  const cwd = runtime.cwd;
  const all = await SessionManager.list(cwd);
  // Newest first — that matches the CLI session picker UX.
  all.sort((a, b) => b.modified.getTime() - a.modified.getTime());
  return { sessions: all.map(summarize) };
}
