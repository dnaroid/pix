import { describe, expect, test } from "bun:test";

import { validateRecovery, type RecoveryReason } from "./recovery-validation.js";
import type { RecoveryProbeEvent } from "./recovery-provenance.js";

const BASH_HANDLE = "/tmp/pi-output/bash-full.log";
const AST_HANDLE = "/tmp/pi-ast-grep/output.txt";

function probe(
	toolCallId: string,
	toolName: string,
	overrides: Partial<RecoveryProbeEvent> = {},
): RecoveryProbeEvent {
	return {
		type: "tool_result_probe",
		toolCallId,
		toolName,
		isError: false,
		contentContainsExpectedFact: false,
		fullOutputFactStatus: "not-provided",
		cleanupExpectedCount: 0,
		cleanupExistingBeforeCount: 0,
		cleanupDeletedCount: 0,
		cleanupMissingAfterCount: 0,
		...overrides,
	};
}

function tempArtifactCase(
	caseId: "recovery.bash-temp-output" | "recovery.ast-grep-temp-output",
	options: {
		producerName?: string;
		handle?: string;
		readPath?: string;
		readUsesAlias?: boolean;
		readBeforeProducer?: boolean;
		producerError?: boolean;
		readError?: boolean;
		producerCount?: number;
		includeRead?: boolean;
		fullOutputStatus?: RecoveryProbeEvent["fullOutputFactStatus"];
		cleanupVerified?: boolean;
		readContainsFact?: boolean;
	} = {},
) {
	const ast = caseId === "recovery.ast-grep-temp-output";
	const producerName = options.producerName ?? (ast ? "ast_grep" : "Bash");
	const handle = options.handle ?? (ast ? AST_HANDLE : BASH_HANDLE);
	const readPath = options.readPath ?? handle;
	const producerCount = options.producerCount ?? 1;
	const includeRead = options.includeRead ?? true;
	const cleanupVerified = options.cleanupVerified ?? true;
	const producerIds = Array.from({ length: producerCount }, (_, index) => `producer-${index + 1}`);
	const readCall = {
		type: "tool_call",
		toolName: "Read",
		toolCallId: "read-1",
		input: options.readUsesAlias === false ? { path: readPath } : { file_path: readPath },
	};
	const readResult = { type: "tool_result", toolName: "Read", toolCallId: "read-1", isError: options.readError === true };
	const events: any[] = [];
	if (options.readBeforeProducer && includeRead) events.push(readCall, readResult);
	for (const id of producerIds) {
		events.push({ type: "tool_call", toolName: producerName, toolCallId: id, input: {} });
		events.push({ type: "tool_result", toolName: producerName, toolCallId: id, isError: options.producerError === true });
	}
	if (!options.readBeforeProducer && includeRead) events.push(readCall, readResult);

	const probes: RecoveryProbeEvent[] = producerIds.map((id) => probe(id, producerName, {
		isError: options.producerError === true,
		fullOutputPath: handle,
		fullOutputFactStatus: options.fullOutputStatus ?? "match",
		cleanupExpectedCount: 1,
		cleanupExistingBeforeCount: cleanupVerified ? 1 : 0,
		cleanupDeletedCount: cleanupVerified ? 1 : 0,
		cleanupMissingAfterCount: cleanupVerified ? 1 : 0,
	}));
	if (includeRead) probes.push(probe("read-1", "Read", {
		isError: options.readError === true,
		contentContainsExpectedFact: options.readContainsFact ?? true,
	}));
	return { result: { caseId, events } as any, probes };
}

function expectReason(
	caseData: ReturnType<typeof tempArtifactCase>,
	reason: RecoveryReason,
): void {
	expect(validateRecovery(caseData.result, caseData.probes).reason).toBe(reason);
}

describe("Context Gateway native recovery validation", () => {
	test("requires the exact producer handle and a successful fact-bearing Read result", () => {
		for (const caseId of ["recovery.bash-temp-output", "recovery.ast-grep-temp-output"] as const) {
			const data = tempArtifactCase(caseId);
			const validation = validateRecovery(data.result, data.probes);
			expect(validation).toMatchObject({
				observationValid: true,
				strategyValid: true,
				recoveryAvailable: true,
				recoveryReads: 1,
				cleanupVerified: true,
			});
			expect(validation.reason).toBe(caseId.includes("bash") ? "bash-full-output" : "ast-grep-full-output");
		}
	});

	test("accepts both Read.file_path and Read.path only when they equal the issued handle", () => {
		const alias = tempArtifactCase("recovery.bash-temp-output", { readUsesAlias: true });
		expect(validateRecovery(alias.result, alias.probes).strategyValid).toBe(true);
		const native = tempArtifactCase("recovery.bash-temp-output", { readUsesAlias: false });
		expect(validateRecovery(native.result, native.probes).strategyValid).toBe(true);
		const unrelated = tempArtifactCase("recovery.bash-temp-output", { readPath: "/tmp/other-output.log" });
		expectReason(unrelated, "read-path-mismatch");
	});

	test("rejects Read before producer result, source reads, producer reruns, and direct guessing", () => {
		expectReason(tempArtifactCase("recovery.bash-temp-output", { readBeforeProducer: true }), "read-before-producer-result");
		expectReason(tempArtifactCase("recovery.bash-temp-output", { readPath: "emit-large-recovery.mjs" }), "direct-source-read");
		expectReason(tempArtifactCase("recovery.ast-grep-temp-output", { readPath: "src/ast-recovery.ts" }), "direct-source-read");
		expectReason(tempArtifactCase("recovery.bash-temp-output", { producerCount: 2 }), "producer-repeated");
		expectReason(tempArtifactCase("recovery.bash-temp-output", { includeRead: false }), "recovery-read-missing");
	});

	test("rejects failed producer/read, unverified cleanup, and handles without the hidden fact", () => {
		expectReason(tempArtifactCase("recovery.bash-temp-output", { producerError: true }), "producer-error");
		expectReason(tempArtifactCase("recovery.bash-temp-output", { readError: true }), "read-error");
		expectReason(tempArtifactCase("recovery.bash-temp-output", { cleanupVerified: false }), "cleanup-not-verified");
		expectReason(tempArtifactCase("recovery.bash-temp-output", { fullOutputStatus: "no-match" }), "full-output-fact-missing");
		expectReason(tempArtifactCase("recovery.bash-temp-output", { readContainsFact: false }), "fact-not-recovered");
	});

	test("distinguishes unavailable native temp-output states instead of collapsing them into a fact miss", () => {
		expectReason(tempArtifactCase("recovery.bash-temp-output", { fullOutputStatus: "missing" }), "full-output-missing");
		expectReason(tempArtifactCase("recovery.bash-temp-output", { fullOutputStatus: "not-file" }), "full-output-not-file");
		expectReason(tempArtifactCase("recovery.ast-grep-temp-output", { fullOutputStatus: "too-large" }), "full-output-too-large");
		expectReason(tempArtifactCase("recovery.ast-grep-temp-output", { fullOutputStatus: "read-error" }), "full-output-read-error");
	});

	test("does not trust a full-output-looking path unless the producer details probe issued it", () => {
		const data = tempArtifactCase("recovery.bash-temp-output", { fullOutputStatus: "not-provided" });
		data.probes[0] = probe("producer-1", "Bash", {
			// A fake path could have appeared in visible text, but no details.fullOutputPath was issued.
			fullOutputFactStatus: "not-provided",
			cleanupExpectedCount: 1,
			cleanupExistingBeforeCount: 1,
			cleanupDeletedCount: 1,
			cleanupMissingAfterCount: 1,
		});
		expectReason(data, "full-output-unavailable");
	});

	test("validates Read continuation against the same source and the exact native offset hint", () => {
		const result = {
			caseId: "recovery.read-offset",
			events: [
				{ type: "tool_call", toolName: "Read", toolCallId: "read-0", input: { file_path: "large-read-recovery.txt" } },
				{ type: "tool_result", toolName: "Read", toolCallId: "read-0", isError: false },
				{ type: "tool_call", toolName: "Read", toolCallId: "read-1", input: { file_path: "large-read-recovery.txt", offset: 2001 } },
				{ type: "tool_result", toolName: "Read", toolCallId: "read-1", isError: false },
			] as any,
		};
		const probes = [
			probe("read-0", "Read", { nativeContinuationOffset: 2001 }),
			probe("read-1", "Read", { contentContainsExpectedFact: true }),
		];
		expect(validateRecovery(result, probes)).toEqual({
			observationValid: true,
			strategyValid: true,
			recoveryAvailable: true,
			recoveryReads: 1,
			reason: "native-offset",
			cleanupVerified: true,
		});

		const wrongOffset = structuredClone(result);
		(wrongOffset.events[2]!.input as any).offset = 1999;
		expect(validateRecovery(wrongOffset, probes).reason).toBe("offset-mismatch");
		const wrongSource = structuredClone(result);
		(wrongSource.events[2]!.input as any).file_path = "other.txt";
		expect(validateRecovery(wrongSource, probes).reason).toBe("source-path-mismatch");
	});

	test("rejects missing continuation, failed continuation result, and unknown cases", () => {
		const base = {
			caseId: "recovery.read-offset",
			events: [
				{ type: "tool_call", toolName: "Read", toolCallId: "read-0", input: { path: "large-read-recovery.txt" } },
				{ type: "tool_result", toolName: "Read", toolCallId: "read-0", isError: false },
			] as any,
		};
		expect(validateRecovery(base, [probe("read-0", "Read")]).reason).toBe("continuation-unavailable");

		const errorResult = {
			caseId: "recovery.read-offset",
			events: [
				...base.events,
				{ type: "tool_call", toolName: "Read", toolCallId: "read-1", input: { path: "large-read-recovery.txt", offset: 2001 } },
				{ type: "tool_result", toolName: "Read", toolCallId: "read-1", isError: true },
			] as any,
		};
		expect(validateRecovery(errorResult, [
			probe("read-0", "Read", { nativeContinuationOffset: 2001 }),
			probe("read-1", "Read", { isError: true }),
		]).reason).toBe("read-error");

		expect(validateRecovery({ caseId: "recovery.future-case", events: [] } as any, []).reason).toBe("unknown-case");
	});
});
