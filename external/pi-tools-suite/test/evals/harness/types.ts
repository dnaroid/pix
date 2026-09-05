export type EvalCategory = "tool-selection" | "coding-quality" | "orchestration" | "negative";

export type EvalEvent = {
	type: "tool_call" | "tool_result" | "agent_end";
	toolName?: string;
	input?: unknown;
	isError?: boolean;
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
