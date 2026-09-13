import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { formatDcpStatistics } from "../../../external/pi-tools-suite/src/dcp/statistics.js";

export type FormatDcpStatsOptions = {
  /** Must contain the complete ACTIVE branch, never a presentation cursor. */
  branch?: readonly unknown[];
};

/** On-demand TUI path: read the full branch asynchronously without hydrating
 * the lazy presentation manager or blocking terminal input. ACP supplies a
 * complete branch directly to the synchronous formatter instead. */
export async function loadDcpStatsToast(session: AgentSession): Promise<string> {
  const manager = session.sessionManager as AgentSession["sessionManager"] & { readFullBranchEntries?: () => Promise<readonly unknown[]> };
  if (!manager.readFullBranchEntries) return formatDcpStatsToast(session);
  const sessionId = manager.getSessionId?.(), leafId = manager.getLeafId?.();
  const model = session.model;
  try {
    const branch = await manager.readFullBranchEntries();
    if (session.sessionManager !== manager || manager.getSessionId?.() !== sessionId || manager.getLeafId?.() !== leafId || session.model !== model) {
      throw new Error("Statistics owner changed during read");
    }
    return formatDcpStatsToast(session, { branch });
  } catch {
    let usage: unknown;
    try { usage = session.getContextUsage(); } catch { /* Unknown. */ }
    return formatDcpStatistics({ model: session.model, usage, historyStatus: "unavailable" });
  }
}

/** TUI and ACP use the same passive report as /dcp stats. Opening this view
 * never re-runs pruning, mutates history, or launches a model. */
export function formatDcpStatsToast(session: AgentSession, options: FormatDcpStatsOptions = {}): string {
  let branch: readonly unknown[] = [];
  let historyStatus: "full" | "unavailable" = "full";
  try {
    if (options.branch) branch = options.branch;
    else {
      const manager = session.sessionManager as AgentSession["sessionManager"] & { readFullBranchEntriesSync?: () => readonly unknown[] };
      branch = manager.readFullBranchEntriesSync ? manager.readFullBranchEntriesSync() : manager.getBranch();
    }
    if (!Array.isArray(branch) || (branch[0] as { parentId?: unknown } | undefined)?.parentId != null) {
      historyStatus = "unavailable";
      branch = [];
    }
  } catch {
    // A broken full reader is not permission to substitute the UI's lazy tail.
    historyStatus = "unavailable";
  }
  let usage: unknown;
  try { usage = session.getContextUsage(); } catch { /* Explicitly unknown. */ }
  return formatDcpStatistics({ branch, historyStatus, model: session.model, usage });
}
