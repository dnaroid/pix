import type { AgentState } from "./lib.js";

export interface LiveAgent {
	runDir: string;
	agentId: string;
	preview?: AgentTaskPreview;
	/** Parent pi session that spawned/adopted this sub-agent, when known. */
	parentSession?: string;
	completed: Promise<void>;
}

export interface AgentTaskPreview {
	id: string;
	task?: string;
	scope?: string;
	model?: string;
}

export interface SubagentRunRenderDetails {
	runDir: string;
	agents: AgentState[];
	tasks?: AgentTaskPreview[];
	mode?: "spawn" | "status" | "wait" | "stop" | "completion";
	agentId?: string;
	state?: AgentState;
}

export interface SubagentLiveStateRun {
	runDir: string;
	agents: AgentState[];
	tasks?: AgentTaskPreview[];
}

export interface SubagentsLiveStateEvent {
	version: 1;
	count: number;
	runs: SubagentLiveStateRun[];
	sessionFile?: string;
	checkedAt: number;
}

export interface TextToolUpdate {
	content: { type: "text"; text: string }[];
	details: SubagentRunRenderDetails;
}
