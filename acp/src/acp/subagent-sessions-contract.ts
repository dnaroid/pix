import type { DesktopModelUsageRefresh, DesktopModelUsageStatus } from "./desktop-commands.js";
import type { SessionTodoSnapshot } from "./session-todos-contract.js";

/**
 * Desktop wire contract for read-only sub-agent session viewers.
 * Dependency-free so Desktop can import it directly; the Node implementation
 * lives in `subagent-sessions.ts`.
 */

export const PIX_SUBAGENT_OPEN_SESSION_METHOD = "pix/subagents/open_session";
export const PIX_SUBAGENT_FORK_SESSION_METHOD = "pix/subagents/fork_session";
export const PIX_SUBAGENT_SESSION_STATE_METHOD = "pix/subagents/session_state";
export const PIX_SUBAGENT_META_KEY = "pix.subagent";

/** Persisted viewer identity; the session map record stores it. */
export interface SubagentSessionLink {
	readonly runDir: string;
	readonly agentId: string;
	/** ACP id of the parent session that opened the viewer, when known. */
	readonly parentSessionId?: string;
}

export interface SubagentSessionState {
	/** Display-only: the child wrote a final exit code and no retry is pending. */
	readonly terminal: boolean;
	/** Changes when the persisted JSONL changes; Desktop refreshes on change. */
	readonly revision: string;
	/** Last recorded model of the child session, when known (display only). */
	readonly model?: SubagentSessionModel;
	/** Context usage of the last assistant turn; needs a known context window. */
	readonly context?: SubagentSessionContext;
	/** Private child plan from persisted todo snapshots, never the parent's plan. */
	readonly todo?: SessionTodoSnapshot;
	/** Provider quota for the child's recorded model, without loading its runtime. */
	readonly modelUsageRefresh?: DesktopModelUsageRefresh;
	readonly modelUsage?: DesktopModelUsageStatus;
	readonly modelUsageCredentialPending?: true;
}

export interface SubagentSessionModel {
	readonly provider: string;
	readonly modelId: string;
	readonly name: string;
	readonly thinking?: string;
}

export interface SubagentSessionContext {
	readonly tokens: number | null;
	readonly contextWindow: number;
	readonly percent: number | null;
}

export interface DesktopSubagentOpenSessionRequest {
	readonly sessionId: string;
	readonly runDir: string;
	readonly agentId: string;
}

export interface DesktopSubagentOpenSessionResponse extends SubagentSessionState {
	readonly sessionId: string;
	readonly link: SubagentSessionLink;
}

export interface DesktopSubagentForkSessionResponse {
	readonly sessionId: string;
}

export type DesktopSubagentSessionStateResponse = SubagentSessionState;
