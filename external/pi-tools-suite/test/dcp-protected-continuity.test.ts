import { describe, expect, test } from "bun:test";

import { loadConfig } from "../src/dcp/config.js";
import { toolRecordContinuity } from "../src/dcp/protected-continuity.js";
import { isToolRecordPruningProtected } from "../src/dcp/pruner-tools.js";
import type { ToolRecord } from "../src/dcp/state.js";

function record(overrides: Partial<ToolRecord> = {}): ToolRecord {
	return {
		toolCallId: "call-1",
		toolName: "shell",
		inputArgs: { command: "git status --short" },
		inputFingerprint: "shell::fixture",
		isError: false,
		turnIndex: 0,
		timestamp: 1,
		tokenEstimate: 5000,
		outputText: "M dist/a.js\n".repeat(3_000),
		...overrides,
	};
}

describe("DCP protected continuity", () => {
	test("keeps shell protected from pruning while compacting proven inspection continuity", () => {
		const config = loadConfig({ homeDir: "/__dcp_protected_continuity__" });
		const source = record();
		expect(isToolRecordPruningProtected(source, config)).toBe(true);

		const continuity = toolRecordContinuity(source, config);
		expect(continuity.mode).toBe("digest");
		expect(continuity.reason).toBe("read-only-inspection");
		expect(continuity.text).toContain("Command: git status --short");
		expect(continuity.text).toContain("Outcome: success");
		expect(continuity.text).toContain("sha256:");
		expect(continuity.text!.length).toBeLessThan(800);
		expect(continuity.text).not.toContain("M dist/a.js\nM dist/a.js\nM dist/a.js");
	});

	test("compacts a proven compound inspection pipeline with temp-only staging", () => {
		const config = loadConfig({ homeDir: "/__dcp_protected_continuity__" });
		const outputText = "README match detail\n".repeat(2_000);
		const continuity = toolRecordContinuity(record({
			inputArgs: {
				command: "rg -n 'Project-local agents|\\.pi/agents' README.md > /tmp/readme.log; printf 'MATCH_RESULT\\n'; head -n 180 /tmp/readme.log",
			},
			outputText,
		}), config);
		expect(continuity.mode).toBe("digest");
		expect(continuity.reason).toBe("read-only-inspection");
		expect(continuity.text).toContain("Classification: inspection");
		expect(continuity.text).toContain("Raw output identity:");
		expect(continuity.text!.length).toBeLessThan(1_000);
		expect(continuity.text).not.toContain("README match detail\nREADME match detail");
	});

	test("compacts a confidently recognised simple Bun test result", () => {
		const config = loadConfig({ homeDir: "/__dcp_protected_continuity__" });
		const bunOutput = [
			"bun test v1.3.14 (0d9b296a)",
			...Array.from({ length: 25 }, (_, index) => `(pass) a.test.ts > case ${index + 1} [1.00ms] ${"detail ".repeat(8)}`),
			"",
			" 25 pass",
			" 0 fail",
			" 50 expect() calls",
			"Ran 25 tests across 1 file. [5.00ms]",
		].join("\n");
		const continuity = toolRecordContinuity(record({
			inputArgs: { command: "bun test test/a.test.ts" },
			outputText: bunOutput,
		}), config);
		expect(continuity.mode).toBe("digest");
		expect(continuity.reason).toBe("recognised-test-build");
		expect(continuity.text).toContain("Execution outcome: SUCCESS");
		expect(continuity.text).toContain("25 passed");
		expect(continuity.text!.length).toBeLessThan(bunOutput.length);
	});

	test("preserves actionable failure evidence in a compact recognised test digest", () => {
		const config = loadConfig({ homeDir: "/__dcp_protected_continuity__" });
		const bunOutput = [
			"bun test v1.3.14 (0d9b296a)",
			...Array.from({ length: 25 }, (_, index) => `(pass) a.test.ts > ok ${index + 1} [1.00ms] ${"detail ".repeat(8)}`),
			"(fail) a.test.ts > broken contract [2.00ms]",
			"Error: expected compact continuity marker",
			"",
			" 25 pass",
			" 1 fail",
			"Ran 26 tests across 1 file. [7.00ms]",
		].join("\n");
		const continuity = toolRecordContinuity(record({
			inputArgs: { command: "bun test test/a.test.ts" },
			outputText: bunOutput,
			isError: true,
		}), config);
		expect(continuity.mode).toBe("digest");
		expect(continuity.reason).toBe("recognised-test-build");
		expect(continuity.text).toContain("Execution outcome: ERROR");
		expect(continuity.text).toContain("(fail) a.test.ts > broken contract");
		expect(continuity.text).toContain("Error: expected compact continuity marker");
		expect(continuity.text).toContain("25 passed, 1 failed, 26 tests, 1 files");
		expect(continuity.text!.length).toBeLessThan(bunOutput.length);
	});

	test("retains exact output for mutation, compound, unknown, protected-path, and unrecognised test commands", () => {
		const config = loadConfig({ homeDir: "/__dcp_protected_continuity__" });
		for (const inputArgs of [
			{ command: "git checkout main" },
			{ command: "git status && git diff" },
			{ command: "node custom-runner.mjs" },
			{ command: "bun test test/a.test.ts" },
		]) {
			const outputText = inputArgs.command.startsWith("bun test") ? "custom output with no terminal summary" : "EXACT_SIDE_EFFECT_EVIDENCE";
			const continuity = toolRecordContinuity(record({ inputArgs, outputText }), config);
			expect(continuity.mode).toBe("verbatim");
			expect(continuity.text).toContain(outputText);
		}

		config.protectedFilePatterns = ["secrets/**"];
		const protectedPath = toolRecordContinuity(record({
			inputArgs: { command: "git status --short", cwd: "secrets/project" },
			outputText: "EXACT_PROTECTED_PATH_OUTPUT",
		}), config);
		expect(protectedPath.mode).toBe("verbatim");
		expect(protectedPath.reason).toBe("protected-file-pattern");
	});

	test("configured non-shell protected tools retain verbatim continuity", () => {
		const config = loadConfig({ homeDir: "/__dcp_protected_continuity__" });
		config.compress.protectedTools.push("read");
		const continuity = toolRecordContinuity(record({
			toolName: "read",
			inputArgs: { path: "src/a.ts" },
			outputText: "EXACT_READ_OUTPUT",
		}), config);
		expect(continuity).toMatchObject({ mode: "verbatim", reason: "non-shell-protected-tool" });
		expect(continuity.text).toContain("EXACT_READ_OUTPUT");
	});

	test("does not replace a tiny protected result with a larger continuity digest", () => {
		const config = loadConfig({ homeDir: "/__dcp_protected_continuity__" });
		const continuity = toolRecordContinuity(record({
			inputArgs: { command: "git status --short" },
			outputText: "clean\n",
		}), config);
		expect(continuity).toMatchObject({
			mode: "verbatim",
			reason: "read-only-inspection-not-smaller",
		});
		expect(continuity.text).toBe("### Tool: shell\nclean");
	});

	test("recognises an already compact Gateway representation without reconstructing raw continuity", () => {
		const config = loadConfig({ homeDir: "/__dcp_protected_continuity__" });
		const compact = "Execution outcome: SUCCESS\nRecognised format: bun-test\nTerminal summary: 25 passed, 0 failed, 25 tests, 1 files";
		const continuity = toolRecordContinuity(record({
			inputArgs: { command: "bun test test/a.test.ts" },
			outputText: compact,
			outputDetails: {
				contextGateway: {
					version: 1,
					representation: "test-build-compact",
					sourceContentBytes: 30_000,
					deliveredContentBytes: 160,
				},
			},
		}), config);
		expect(continuity).toMatchObject({ mode: "verbatim", reason: "gateway-compacted" });
		expect(continuity.text).toContain(compact);
		expect(continuity.text!.length).toBeLessThan(300);
	});
});
