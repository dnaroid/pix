export type ContextGatewayMode = "off" | "observe" | "enforce";

export type ContextGatewayEffectiveMode = ContextGatewayMode;

export interface ContextGatewayBudgets {
	maxInlineBytes: number;
	maxResultBytes: number;
	maxExactReadBytes: number;
	maxSearchBytes: number;
	maxSearchMatches: number;
}

/** Parsed layered config. `enforce` is selective and fail-open for unsupported result classes. */
export interface ContextGatewayResolvedConfig {
	mode: ContextGatewayMode;
	budgets: ContextGatewayBudgets;
	issues: string[];
}

export type ContextGatewayToolClass =
	| "code-read"
	| "shell"
	| "repo-search"
	| "repo-ast"
	| "repo-structure"
	| "ast-grep"
	| "mutation"
	| "web"
	| "subagent"
	| "other";

export type ContextGatewayExecutionOutcome = "success" | "error";

export type ContextGatewayObservedCompleteness = "upstream-truncated" | "unknown";

export interface ContextGatewayObservedSource {
	kind: "tool-result-boundary";
	completeness: ContextGatewayObservedCompleteness;
	contentBytes: number;
	textBytes: number;
	imageBytes: number;
	detailsBytes: number;
}

export interface ContextGatewayObservedView {
	kind: "text-content";
	textBytes: number;
}

export interface ContextGatewayObservedDelivery {
	representation: "passthrough" | "test-build-compact" | "web-recoverable-compact";
	contentBytes: number;
	textBytes: number;
}

export type ContextGatewayTestOutputClassification = "recognised" | "partial" | "unrecognised";
export type ContextGatewayTestOutputFormat = "bun-test" | "tap" | "typescript" | "mixed" | "unknown";

export interface ContextGatewayTestOutputObservation {
	parserVersion: 1;
	classification: ContextGatewayTestOutputClassification;
	format: ContextGatewayTestOutputFormat;
	scanLimited: boolean;
	terminalSummarySeen: boolean;
	diagnosticCount: number;
	warningCount: number;
	commandScope: "simple" | "compound" | "unknown";
	prospectiveDecision: "compact-candidate" | "passthrough";
	prospectiveReason:
		| "recognised-complete"
		| "parser-not-complete"
		| "upstream-truncated"
		| "termination-not-normal"
		| "compound-command"
		| "command-scope-unknown"
		| "compact-budget-exceeded";
}

/** P01 keeps only metadata/sizes. No body, arguments, paths, or secret-derived hashes are exposed. */
export interface ContextGatewayObservation {
	version: 1;
	toolClass: ContextGatewayToolClass;
	outcome: ContextGatewayExecutionOutcome;
	budgetBytes: number;
	source: ContextGatewayObservedSource;
	view: ContextGatewayObservedView;
	delivery: ContextGatewayObservedDelivery;
	overBudget: boolean;
	potentialBytesOverBudget: number;
	actualBytesSaved: number;
	testOutput?: ContextGatewayTestOutputObservation;
}

export interface ContextGatewayClassTelemetry {
	results: number;
	errors: number;
	contentBytes: number;
	deliveredContentBytes: number;
	textBytes: number;
	imageBytes: number;
	detailsBytes: number;
	upstreamTruncatedResults: number;
	overBudgetResults: number;
	potentialBytesOverBudget: number;
	enforcedResults: number;
	actualBytesSaved: number;
}

export type ContextGatewayNativePolicyReason =
	| "invalid-wrapper-budget"
	| "unknown-flag"
	| "missing-flag-value"
	| "duplicate-flag"
	| "invalid-flag-value"
	| "conflicting-flags"
	| "compact-limit-exceeded"
	| "full-limit-exceeded"
	| "unknown";

export interface ContextGatewayNativePolicyTelemetry {
	results: number;
	refusals: number;
	fullOverrides: number;
	byReason: Partial<Record<ContextGatewayNativePolicyReason, number>>;
}

export interface ContextGatewayTestOutputTelemetry {
	parserVersion: 1;
	results: number;
	scanLimitedResults: number;
	compactCandidates: number;
	passthroughRecommended: number;
	byClassification: Record<ContextGatewayTestOutputClassification, number>;
	byFormat: Record<ContextGatewayTestOutputFormat, number>;
}

export interface ContextGatewayTelemetrySnapshot extends ContextGatewayClassTelemetry {
	version: 1;
	pendingCalls: number;
	unboundResults: number;
	repeatCandidateCount: number;
	sameSourceDifferentRangeCount: number;
	retrievalCalls: number;
	nativePolicy: ContextGatewayNativePolicyTelemetry;
	testOutput: ContextGatewayTestOutputTelemetry;
	byClass: Partial<Record<ContextGatewayToolClass, ContextGatewayClassTelemetry>>;
	lastObservation?: ContextGatewayObservation;
}

export interface ContextGatewayRuntimeState {
	requestedMode: ContextGatewayMode;
	effectiveMode: ContextGatewayEffectiveMode;
	readonly config: ContextGatewayResolvedConfig;
	readonly telemetry: {
		snapshot(): ContextGatewayTelemetrySnapshot;
		reset(): void;
	};
}
