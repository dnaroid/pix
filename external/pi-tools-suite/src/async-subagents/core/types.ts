import type { ChildProcessWithoutNullStreams } from "node:child_process";

export interface AgentTask {
	id: string;
	task: string;
	scope?: string;
	/** Logical sub-agent type/profile, resolved from config before spawning. */
	subagentType?: string;
	/** Explicit model override for this task. */
	model?: string;
	/** Explicit thinking level for this task. */
	thinking?: string;
	/** Extra prompt text appended after the generated or overridden prompt. */
	promptAppend?: string;
	/** Full prompt replacement for this task. Supports prompt template variables. */
	promptOverride?: string;
	/** Optional visual attention instructions for agents that receive imagePaths. */
	focus?: string;
	/** Local image files to attach to the sub-agent RPC prompt. */
	imagePaths?: string[];
	tools?: string[];
	extraArgs?: string[];
	/** Per-agent wall-clock timeout in milliseconds. */
	timeoutMs?: number;
	parentObjective?: string;
}

export interface AgentState {
	id: string;
	status: "planned" | "running" | "retrying" | "done" | "failed" | "stopped";
	exitCode?: number;
	startedAt?: string;
	finishedAt?: string;
	/** ISO-8601 timestamp for the next retry attempt while status is retrying. */
	nextRetryAt?: string;
	pid?: number;
	resultLines?: number;
	stderrLines?: number;
	eventLines?: number;
	/** How many times this agent has been retried (0 = first attempt). */
	retryCount?: number;
}

/** Retry configuration for failed agents. */
export interface RetryConfig {
	/** Maximum number of retry attempts (default 0 = no retries). */
	maxRetries: number;
	/** Base delay in ms before first retry, doubled on each subsequent attempt (default 2000). */
	backoffMs: number;
	/** Exit codes eligible for retry. Default: all non-zero. Empty array disables retry. */
	retryableExitCodes?: number[];
}

export interface RunState {
	runDir: string;
	agents: AgentState[];
}

export type StructuredSeverity = "low" | "medium" | "high" | "critical";

export interface StructuredFinding {
	text: string;
	severity?: StructuredSeverity;
	file?: string;
	line?: number;
}

export interface StructuredFileReference {
	path: string;
	line?: number;
}

export interface StructuredRisk {
	text: string;
	severity?: StructuredSeverity;
}

/** Machine-readable structured result written alongside result.md. */
export interface StructuredResult {
	/** Structured result schema version. */
	schemaVersion?: 2;
	/** Agent identifier. */
	agentId: string;
	/** Final status. */
	status: AgentState["status"];
	/** Process exit code. */
	exitCode?: number;
	/** ISO-8601 start timestamp. */
	startedAt?: string;
	/** ISO-8601 finish timestamp. */
	finishedAt?: string;
	/** Wall-clock duration in seconds. */
	durationSeconds?: number;
	/** Retry count (0 = first attempt, omitted when never retried). */
	retryCount?: number;
	/** Sub-agent type that was used. */
	subagentType?: string;
	/** Model used by the sub-agent. */
	model?: string;
	/** The full result text (may be truncated by maxResultBytes). */
	resultText?: string;
	/** True when resultText was truncated. */
	resultTruncated?: boolean;
	/** Original byte length before truncation. */
	resultOriginalBytes?: number;
	/** Compact best-effort summary extracted from resultText for parent-agent chaining. */
	summary?: string;
	/** Best-effort findings extracted from bullet/checklist style result text. */
	findings?: StructuredFinding[];
	/** File references mentioned in result text. */
	files?: StructuredFileReference[];
	/** Best-effort risk statements extracted from result text. */
	risks?: StructuredRisk[];
	/** Best-effort recommended next actions extracted from result text. */
	nextActions?: string[];
	/** Optional confidence if the agent explicitly reports it. */
	confidence?: "low" | "medium" | "high";
	/** First line(s) of stderr, if any. */
	stderrPreview?: string;
}

export interface AgentResult {
	/** True when result.md exists. Raw text is only populated for explicit internal readers. */
	resultAvailable?: boolean;
	result?: string;
	/** True when stderr.log exists and may contain diagnostics. Raw text is only populated for explicit internal readers. */
	stderrAvailable?: boolean;
	stderr?: string;
	exitCode?: number;
	state: AgentState;
	/** Structured JSON result, if available. */
	structured?: StructuredResult;
}

export interface SpawnedAgent {
	pid: number;
	agentDir: string;
	process: ChildProcessWithoutNullStreams;
}

export interface RpcEventRecord {
	type: string;
	[key: string]: unknown;
}

export type RpcEventHandler = (event: RpcEventRecord) => void;

export type AgentCompletionHandler = (completion: {
	runDir: string;
	agentId: string;
	agentDir: string;
	exitCode: number;
	state: AgentState;
}) => void;
