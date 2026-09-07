import * as fs from "node:fs";
import * as path from "node:path";

export const RECOVERY_PROBE_LOG = path.join(".pi", "eval-recovery-provenance.jsonl");

export type RecoveryFactStatus =
	| "not-provided"
	| "match"
	| "no-match"
	| "missing"
	| "not-file"
	| "too-large"
	| "read-error";

export type RecoveryProbeEvent = {
	type: "tool_result_probe";
	toolCallId: string;
	toolName: string;
	isError: boolean;
	contentContainsExpectedFact: boolean;
	nativeContinuationOffset?: number;
	/** Transient only. Never copy this field into a persisted recovery report. */
	fullOutputPath?: string;
	fullOutputFactStatus: RecoveryFactStatus;
	cleanupExpectedCount: number;
	cleanupExistingBeforeCount: number;
	cleanupDeletedCount: number;
	cleanupMissingAfterCount: number;
};

export type RecoveryProbeConfig = {
	expectedFact: string;
	producerToolNames: string[];
	maxFullOutputProbeBytes?: number;
};

export function readRecoveryProbeEvents(projectDir: string): RecoveryProbeEvent[] {
	const filePath = path.join(projectDir, RECOVERY_PROBE_LOG);
	if (!fs.existsSync(filePath)) return [];
	return fs.readFileSync(filePath, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line: string) => JSON.parse(line) as RecoveryProbeEvent);
}
