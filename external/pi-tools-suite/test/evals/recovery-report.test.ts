import { describe, expect, test } from "bun:test";

import { toSafeRecoveryRun } from "./recovery-report.js";
import type { RecoveryProbeEvent } from "./recovery-provenance.js";

describe("Context Gateway recovery safe reporting", () => {
	test("drops transient paths, raw args, stdout/body and hidden facts from the report row", () => {
		const nativeHandle = "/private/transient/pi-output-secret.log";
		const hiddenFact = "RECOVERY_SECRET_FACT=not-for-report";
		const result = {
			caseId: "recovery.bash-temp-output",
			model: "zai/glm-5.3",
			stdout: hiddenFact,
			stderr: "PRIVATE_STDERR",
			passed: true,
			events: [
				{ type: "tool_call", toolCallId: "p1", toolName: "Bash", input: { command: "PRIVATE_COMMAND" } },
				{ type: "tool_result", toolCallId: "p1", toolName: "Bash", isError: false },
				{ type: "tool_call", toolCallId: "r1", toolName: "Read", input: { file_path: nativeHandle } },
				{ type: "tool_result", toolCallId: "r1", toolName: "Read", isError: false },
			],
			metrics: {
				toolCallCount: 2,
				parentUsage: { totalTokens: 123 },
				elapsedMs: 45,
			},
		} as any;
		const probes: RecoveryProbeEvent[] = [
			{
				type: "tool_result_probe",
				toolCallId: "p1",
				toolName: "Bash",
				isError: false,
				contentContainsExpectedFact: false,
				fullOutputPath: nativeHandle,
				fullOutputFactStatus: "match",
				cleanupExpectedCount: 1,
				cleanupExistingBeforeCount: 1,
				cleanupDeletedCount: 1,
				cleanupMissingAfterCount: 1,
			},
			{
				type: "tool_result_probe",
				toolCallId: "r1",
				toolName: "Read",
				isError: false,
				contentContainsExpectedFact: true,
				fullOutputFactStatus: "not-provided",
				cleanupExpectedCount: 0,
				cleanupExistingBeforeCount: 0,
				cleanupDeletedCount: 0,
				cleanupMissingAfterCount: 0,
			},
		];

		const safe = toSafeRecoveryRun(result, probes);
		expect(safe).toMatchObject({
			taskPassed: true,
			observationValid: true,
			recoveryAvailable: true,
			strategyValid: true,
			reason: "bash-full-output",
			toolSequence: ["Bash", "Read"],
		});
		const serialized = JSON.stringify(safe);
		expect(serialized).not.toContain(nativeHandle);
		expect(serialized).not.toContain("PRIVATE_COMMAND");
		expect(serialized).not.toContain(hiddenFact);
		expect(serialized).not.toContain("PRIVATE_STDERR");
	});
});
