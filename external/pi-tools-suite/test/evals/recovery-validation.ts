import * as path from "node:path";

import type { EvalEvent, EvalRunResult } from "./harness/types.js";
import type { RecoveryProbeEvent } from "./recovery-provenance.js";

export const RECOVERY_VALIDATOR_VERSION = 2;

export type RecoveryReason =
	| "native-offset"
	| "bash-full-output"
	| "ast-grep-full-output"
	| "unknown-case"
	| "producer-missing"
	| "producer-repeated"
	| "producer-result-missing"
	| "producer-error"
	| "producer-probe-missing"
	| "continuation-unavailable"
	| "full-output-unavailable"
	| "full-output-missing"
	| "full-output-not-file"
	| "full-output-too-large"
	| "full-output-read-error"
	| "full-output-fact-missing"
	| "cleanup-not-verified"
	| "recovery-read-missing"
	| "read-before-producer-result"
	| "direct-source-read"
	| "read-path-mismatch"
	| "read-result-missing"
	| "read-error"
	| "fact-not-recovered"
	| "source-path-mismatch"
	| "offset-mismatch";

export type RecoveryValidation = {
	observationValid: boolean;
	strategyValid: boolean;
	recoveryAvailable: boolean;
	recoveryReads: number;
	reason: RecoveryReason;
	cleanupVerified: boolean;
};

type RecoveryInput = Pick<EvalRunResult, "caseId" | "events">;

function normalizedToolName(event: EvalEvent): string {
	return (event.toolName ?? "").trim().toLowerCase();
}

function isToolCall(event: EvalEvent): boolean {
	return event.type === "tool_call";
}

function isToolResult(event: EvalEvent): boolean {
	return event.type === "tool_result";
}

function isReadCall(event: EvalEvent): boolean {
	return isToolCall(event) && normalizedToolName(event) === "read";
}

function readInput(event: EvalEvent): Record<string, unknown> {
	return event.input && typeof event.input === "object" && !Array.isArray(event.input)
		? event.input as Record<string, unknown>
		: {};
}

function readPath(event: EvalEvent): string | undefined {
	const input = readInput(event);
	const value = input.file_path ?? input.path;
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function samePath(left: string | undefined, right: string | undefined): boolean {
	if (!left || !right) return false;
	return path.resolve(left) === path.resolve(right);
}

function eventIndex(events: readonly EvalEvent[], target: EvalEvent): number {
	return events.indexOf(target);
}

function resultForCall(events: readonly EvalEvent[], toolCallId: string | undefined): EvalEvent | undefined {
	if (!toolCallId) return undefined;
	return events.find((event) => isToolResult(event) && event.toolCallId === toolCallId);
}

function probeForCall(probes: readonly RecoveryProbeEvent[], toolCallId: string | undefined): RecoveryProbeEvent | undefined {
	if (!toolCallId) return undefined;
	return probes.find((probe) => probe.toolCallId === toolCallId);
}

function validCleanup(probe: RecoveryProbeEvent): boolean {
	if (probe.cleanupExpectedCount === 0) return true;
	return probe.cleanupExistingBeforeCount === probe.cleanupExpectedCount
		&& probe.cleanupDeletedCount === probe.cleanupExpectedCount
		&& probe.cleanupMissingAfterCount === probe.cleanupExpectedCount;
}

function baseFailure(reason: RecoveryReason, options: Partial<RecoveryValidation> = {}): RecoveryValidation {
	return {
		observationValid: options.observationValid ?? false,
		strategyValid: false,
		recoveryAvailable: options.recoveryAvailable ?? false,
		recoveryReads: options.recoveryReads ?? 0,
		reason,
		cleanupVerified: options.cleanupVerified ?? false,
	};
}

function validateReadOffset(result: RecoveryInput, probes: readonly RecoveryProbeEvent[]): RecoveryValidation {
	const calls = result.events.filter(isReadCall);
	if (calls.length === 0) return baseFailure("producer-missing");

	const firstCall = calls[0]!;
	const firstInput = readInput(firstCall);
	const firstPath = readPath(firstCall);
	const firstResult = resultForCall(result.events, firstCall.toolCallId);
	if (!firstResult) return baseFailure("producer-result-missing");
	const firstProbe = probeForCall(probes, firstCall.toolCallId);
	if (!firstProbe) return baseFailure("producer-probe-missing");
	if (firstResult.isError === true || firstProbe.isError) {
		return baseFailure("producer-error", { observationValid: true, cleanupVerified: true });
	}
	if (firstInput.offset !== undefined || firstInput.limit !== undefined || !firstPath) {
		return baseFailure("source-path-mismatch", { observationValid: true, cleanupVerified: true });
	}

	const firstContinuation = firstProbe.nativeContinuationOffset;
	const recoveryAvailable = typeof firstContinuation === "number" && firstContinuation > 0;
	if (!recoveryAvailable) {
		return baseFailure("continuation-unavailable", { observationValid: true, cleanupVerified: true });
	}
	if (firstProbe.contentContainsExpectedFact) {
		return baseFailure("fact-not-recovered", {
			observationValid: true,
			recoveryAvailable: true,
			cleanupVerified: true,
		});
	}

	let previousCall = firstCall;
	let previousResult = firstResult;
	let previousProbe = firstProbe;
	let recoveryReads = 0;

	for (const call of calls.slice(1)) {
		if (eventIndex(result.events, call) <= eventIndex(result.events, previousResult)) {
			return baseFailure("read-before-producer-result", {
				observationValid: true,
				recoveryAvailable: true,
				recoveryReads,
				cleanupVerified: true,
			});
		}
		if (!samePath(readPath(call), firstPath)) {
			return baseFailure("source-path-mismatch", {
				observationValid: true,
				recoveryAvailable: true,
				recoveryReads,
				cleanupVerified: true,
			});
		}
		const expectedOffset = previousProbe.nativeContinuationOffset;
		const actualOffset = readInput(call).offset;
		if (typeof expectedOffset !== "number" || actualOffset !== expectedOffset) {
			return baseFailure("offset-mismatch", {
				observationValid: true,
				recoveryAvailable: true,
				recoveryReads,
				cleanupVerified: true,
			});
		}

		const readResult = resultForCall(result.events, call.toolCallId);
		if (!readResult) {
			return baseFailure("read-result-missing", {
				observationValid: true,
				recoveryAvailable: true,
				recoveryReads,
				cleanupVerified: true,
			});
		}
		const readProbe = probeForCall(probes, call.toolCallId);
		if (!readProbe) {
			return baseFailure("producer-probe-missing", {
				observationValid: false,
				recoveryAvailable: true,
				recoveryReads,
				cleanupVerified: true,
			});
		}
		if (readResult.isError === true || readProbe.isError) {
			return baseFailure("read-error", {
				observationValid: true,
				recoveryAvailable: true,
				recoveryReads,
				cleanupVerified: true,
			});
		}

		recoveryReads += 1;
		if (readProbe.contentContainsExpectedFact) {
			return {
				observationValid: true,
				strategyValid: true,
				recoveryAvailable: true,
				recoveryReads,
				reason: "native-offset",
				cleanupVerified: true,
			};
		}

		previousCall = call;
		previousResult = readResult;
		previousProbe = readProbe;
		void previousCall;
	}

	return baseFailure("fact-not-recovered", {
		observationValid: true,
		recoveryAvailable: true,
		recoveryReads,
		cleanupVerified: true,
	});
}

function validateTempArtifact(
	result: RecoveryInput,
	probes: readonly RecoveryProbeEvent[],
	producerNames: readonly string[],
	sourceSuffix: string,
	successReason: Extract<RecoveryReason, "bash-full-output" | "ast-grep-full-output">,
): RecoveryValidation {
	const producers = result.events.filter((event) => isToolCall(event) && producerNames.includes(normalizedToolName(event)));
	if (producers.length === 0) return baseFailure("producer-missing");
	if (producers.length !== 1) return baseFailure("producer-repeated", { observationValid: true });

	const producer = producers[0]!;
	const producerResult = resultForCall(result.events, producer.toolCallId);
	if (!producerResult) return baseFailure("producer-result-missing");
	const producerProbe = probeForCall(probes, producer.toolCallId);
	if (!producerProbe) return baseFailure("producer-probe-missing");
	const cleanupVerified = validCleanup(producerProbe);
	if (producerResult.isError === true || producerProbe.isError) {
		return baseFailure("producer-error", { observationValid: true, cleanupVerified });
	}
	if (!producerProbe.fullOutputPath || producerProbe.fullOutputFactStatus === "not-provided") {
		return baseFailure("full-output-unavailable", { observationValid: true, cleanupVerified });
	}
	const unavailableReason = (() => {
		switch (producerProbe.fullOutputFactStatus) {
			case "missing": return "full-output-missing" as const;
			case "not-file": return "full-output-not-file" as const;
			case "too-large": return "full-output-too-large" as const;
			case "read-error": return "full-output-read-error" as const;
			case "no-match": return "full-output-fact-missing" as const;
			default: return undefined;
		}
	})();
	if (unavailableReason) {
		return baseFailure(unavailableReason, {
			observationValid: true,
			recoveryAvailable: false,
			cleanupVerified,
		});
	}
	const recoveryAvailable = producerProbe.fullOutputFactStatus === "match";
	if (!recoveryAvailable) {
		return baseFailure("full-output-unavailable", { observationValid: true, cleanupVerified });
	}
	if (!cleanupVerified) {
		return baseFailure("cleanup-not-verified", {
			observationValid: true,
			recoveryAvailable: true,
			cleanupVerified: false,
		});
	}

	const producerResultIndex = eventIndex(result.events, producerResult);
	const readCalls = result.events.filter(isReadCall);
	if (readCalls.some((call) => eventIndex(result.events, call) < producerResultIndex)) {
		return baseFailure("read-before-producer-result", {
			observationValid: true,
			recoveryAvailable: true,
			cleanupVerified: true,
		});
	}
	if (readCalls.length === 0) {
		return baseFailure("recovery-read-missing", {
			observationValid: true,
			recoveryAvailable: true,
			cleanupVerified: true,
		});
	}

	let recoveryReads = 0;
	for (const readCall of readCalls) {
		const candidatePath = readPath(readCall);
		if (candidatePath?.endsWith(sourceSuffix)) {
			return baseFailure("direct-source-read", {
				observationValid: true,
				recoveryAvailable: true,
				recoveryReads,
				cleanupVerified: true,
			});
		}
		if (!samePath(candidatePath, producerProbe.fullOutputPath)) {
			return baseFailure("read-path-mismatch", {
				observationValid: true,
				recoveryAvailable: true,
				recoveryReads,
				cleanupVerified: true,
			});
		}

		const readResult = resultForCall(result.events, readCall.toolCallId);
		if (!readResult) {
			return baseFailure("read-result-missing", {
				observationValid: true,
				recoveryAvailable: true,
				recoveryReads,
				cleanupVerified: true,
			});
		}
		const readProbe = probeForCall(probes, readCall.toolCallId);
		if (!readProbe) return baseFailure("producer-probe-missing", { recoveryAvailable: true, cleanupVerified: true });
		if (readResult.isError === true || readProbe.isError) {
			return baseFailure("read-error", {
				observationValid: true,
				recoveryAvailable: true,
				recoveryReads,
				cleanupVerified: true,
			});
		}

		recoveryReads += 1;
		if (readProbe.contentContainsExpectedFact) {
			return {
				observationValid: true,
				strategyValid: true,
				recoveryAvailable: true,
				recoveryReads,
				reason: successReason,
				cleanupVerified: true,
			};
		}
	}

	return baseFailure("fact-not-recovered", {
		observationValid: true,
		recoveryAvailable: true,
		recoveryReads,
		cleanupVerified: true,
	});
}

export function validateRecovery(
	result: RecoveryInput,
	probes: readonly RecoveryProbeEvent[] = [],
): RecoveryValidation {
	if (result.caseId === "recovery.read-offset") return validateReadOffset(result, probes);
	if (result.caseId === "recovery.bash-temp-output") {
		return validateTempArtifact(result, probes, ["bash", "shell", "shell_command"], "emit-large-recovery.mjs", "bash-full-output");
	}
	if (result.caseId === "recovery.ast-grep-temp-output") {
		return validateTempArtifact(result, probes, ["ast_grep"], "ast-recovery.ts", "ast-grep-full-output");
	}
	return baseFailure("unknown-case");
}
