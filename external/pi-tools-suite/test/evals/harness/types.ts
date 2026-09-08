import type {
	ContextGatewayBudgets,
	ContextGatewayTelemetrySnapshot,
} from "../../../src/context-gateway/types.js";

export type EvalCategory = "tool-selection" | "coding-quality" | "orchestration" | "negative";

export type EvalContextGatewayTelemetry = {
	mode: "observe";
	maxResultBytes: number;
	budgets: ContextGatewayBudgets;
	snapshot: ContextGatewayTelemetrySnapshot;
};

export type EvalEvent = {
	type: "tool_call" | "tool_result" | "agent_end";
	toolCallId?: string;
	toolName?: string;
	input?: unknown;
	isError?: boolean;
	contentBytes?: number;
	textBytes?: number;
	nativePolicy?: {
		refused: boolean;
		outputMode?: "compact" | "full";
		reason?: string;
	};
	contextGatewayTelemetry?: EvalContextGatewayTelemetry;
	usage?: EvalUsage;
};

export type EvalUsage = {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	cost: number;
};

export type EvalMetrics = {
	elapsedMs: number;
	toolCallCount: number;
	toolCalls: string[];
	failedToolResults: number;
	toolResultContentBytes: number;
	toolResultTextBytes: number;
	repoResultContentBytes: number;
	nativePolicyResults: number;
	nativePolicyRefusals: number;
	nativePolicyFullOverrides: number;
	retryAfterNativeRefusalCount: number;
	contextGateway?: EvalContextGatewayTelemetry;
	mutationCount: number;
	verificationCount: number;
	changedFiles: string[];
	parentUsage: EvalUsage;
	subagentUsage: EvalUsage;
	subagentCount: number;
};

export type EvalAssertionSpec = {
	requiredTools?: string[];
	forbiddenTools?: string[];
	firstTool?: string;
	firstToolOneOf?: string[];
	maxToolCalls?: number;
	maxMutations?: number;
	maxFilesChanged?: number;
	requireReproBeforeMutation?: boolean;
	requireVerificationAfterMutation?: boolean;
	stdoutIncludes?: string[];
	stdoutExcludes?: string[];
	postRunCommands?: Array<{ command: string; expectedExit?: number; stdoutIncludes?: string[] }>;
};

export type EvalCase = {
	id: string;
	category: EvalCategory;
	description: string;
	prompt: string;
	fixture: "demo" | "coding-hypotheses" | "coding-regression" | "coding-async";
	indexed?: boolean;
	fakeIdx?: boolean;
	blockTools?: string[];
	models?: RegExp[];
	env?: Record<string, string>;
	assert: EvalAssertionSpec;
	validate?: (result: EvalRunResult) => string[];
};

export type EvalAssertionResult = {
	name: string;
	passed: boolean;
	detail?: string;
};

export type EvalRunResult = {
	caseId: string;
	model: string;
	projectDir: string;
	stdout: string;
	stderr: string;
	exitCode: number | null;
	timedOut: boolean;
	events: EvalEvent[];
	metrics: EvalMetrics;
	assertions: EvalAssertionResult[];
	passed: boolean;
};

export type EvalReport = {
	startedAt: string;
	finishedAt: string;
	models: string[];
	results: EvalRunResult[];
};
