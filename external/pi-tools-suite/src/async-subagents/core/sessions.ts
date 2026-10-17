import * as path from "node:path";
import { getRunRoot, PARENT_SESSION_ID_PATTERN } from "./paths.js";

/** Legacy per-agent session directory (`<agentDir>/sessions`), used only without a persisted parent session. */
export function getAgentSessionDir(agentDir: string): string {
	return path.join(agentDir, "sessions");
}

/**
 * Project-local directory for children of one parent session:
 * `<cwd>/.pi/subagents/<parentSessionId>/`. Kept out of the global session
 * store, so resume lists and usage stats never see children, and removing the
 * directory removes every child of that parent. Undefined for an unsafe id.
 */
export function getParentSubagentSessionDir(cwd: string, parentSessionId: string | undefined): string | undefined {
	const id = parentSessionId?.trim();
	if (!id || !PARENT_SESSION_ID_PATTERN.test(id)) return undefined;
	return path.join(getRunRoot(cwd), id);
}

/** Session directory for a child: the parent-scoped project dir when known, else the legacy agent dir. */
export function getSubagentSessionDir(agentDir: string, cwd: string, parentSessionId: string | undefined): string {
	return getParentSubagentSessionDir(cwd, parentSessionId) ?? getAgentSessionDir(agentDir);
}
