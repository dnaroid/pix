import type { EvalRunResult } from "./harness/types.js";
import type { RecoveryProbeEvent } from "./recovery-provenance.js";
import type { RecoveryRunIdentity } from "./recovery-run-identity.js";
import { validateRecovery, type RecoveryValidation } from "./recovery-validation.js";

export type RecoverySafeRun = {
	caseId: string;
	model: string;
	taskPassed: boolean;
	observationValid: boolean;
	recoveryAvailable: boolean;
	strategyValid: boolean;
	cleanupVerified: boolean;
	recoveryReads: number;
	reason: RecoveryValidation["reason"];
	toolSequence: string[];
	toolCalls: number;
	parentTokens: number;
	elapsedMs: number;
	overBudgetResults: number;
	upstreamTruncatedResults: number;
};

export function toSafeRecoveryRun(
	result: EvalRunResult,
	probes: readonly RecoveryProbeEvent[],
): RecoverySafeRun {
	const validation = validateRecovery(result, probes);
	return {
		caseId: result.caseId,
		model: result.model,
		taskPassed: result.passed,
		observationValid: validation.observationValid,
		recoveryAvailable: validation.recoveryAvailable,
		strategyValid: validation.strategyValid,
		cleanupVerified: validation.cleanupVerified,
		recoveryReads: validation.recoveryReads,
		reason: validation.reason,
		toolSequence: result.events
			.filter((event) => event.type === "tool_call")
			.map((event) => event.toolName ?? "unknown"),
		toolCalls: result.metrics.toolCallCount,
		parentTokens: result.metrics.parentUsage.totalTokens,
		elapsedMs: result.metrics.elapsedMs,
		overBudgetResults: result.metrics.contextGateway?.snapshot.overBudgetResults ?? 0,
		upstreamTruncatedResults: result.metrics.contextGateway?.snapshot.upstreamTruncatedResults ?? 0,
	};
}

export function renderRecoveryMarkdown(
	startedAt: string,
	finishedAt: string,
	identity: RecoveryRunIdentity,
	runs: readonly RecoverySafeRun[],
): string {
	const lines = [
		"# Context Gateway Native Recovery Evidence",
		"",
		`Started: ${startedAt}`,
		`Finished: ${finishedAt}`,
		`Report/corpus/validator: v${identity.reportVersion}/v${identity.corpusVersion}/v${identity.validatorVersion}`,
		`Package source SHA-256: ${identity.testedPackage.sourceSha256}`,
		`Entrypoint SHA-256: ${identity.testedPackage.entrypointSha256}`,
		`SDK/runtime: pi-coding-agent ${identity.sdk.piCodingAgentVersion ?? "unknown"}; Node ${identity.runtime.node}; Bun ${identity.runtime.bun ?? "unknown"}; ${identity.runtime.platform}/${identity.runtime.arch}`,
		"",
		"> Synthetic new sessions only. Final reports store no tool arguments, paths, result bodies, artifact contents, or hidden-fact fingerprints. Exact native handles exist only in the disposable per-run provenance file and are deleted with the fixture project after validation.",
		"",
		"| Case | Model | Task | Observation | Recovery available | Strategy | Cleanup | Reason | Tools | Recovery reads | Calls | Tokens | Time | Over-budget | Upstream-truncated |",
		"| --- | --- | ---: | ---: | ---: | ---: | ---: | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |",
	];
	for (const run of runs) {
		lines.push(`| ${run.caseId} | ${run.model} | ${run.taskPassed ? "PASS" : "FAIL"} | ${run.observationValid ? "PASS" : "FAIL"} | ${run.recoveryAvailable ? "YES" : "NO"} | ${run.strategyValid ? "PASS" : "FAIL"} | ${run.cleanupVerified ? "PASS" : "FAIL"} | ${run.reason} | ${run.toolSequence.join(" → ")} | ${run.recoveryReads} | ${run.toolCalls} | ${run.parentTokens} | ${(run.elapsedMs / 1000).toFixed(1)}s | ${run.overBudgetResults} | ${run.upstreamTruncatedResults} |`);
	}
	return lines.join("\n") + "\n";
}
