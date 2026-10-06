import { describe, expect, test } from "bun:test";
import { evaluateAssertions } from "./harness/assertions.js";
import { deriveMetrics } from "./harness/metrics.js";
import type { EvalEvent, EvalRunResult } from "./harness/types.js";
import { SESSION_EVAL_CASES } from "./session-cases.js";

const INPUTS: Record<string, Record<string, unknown>[]> = {
	"tool.session-recovery-overview": [{ action: "overview" }],
	"tool.session-name-set": [{ action: "name", name: "Checkout retry audit" }],
	"tool.session-name-read": [{ action: "name" }],
	"tool.session-recovery-read": [{ action: "overview" }, { action: "read", entry_id: "mapped-entry" }],
	"tool.session-recovery-search": [{ action: "search", query: "SESSION-SEARCH-ANCHOR" }],
	"tool.session-recovery-signals": [{ action: "overview" }, { action: "recovery", recent_error_limit: 3 }],
};

function makeResult(id: string): EvalRunResult {
	const events: EvalEvent[] = INPUTS[id]!.flatMap((input, index) => [
		{ type: "tool_call", toolName: "session", toolCallId: `call-${index}`, input: { ...input } },
		{ type: "tool_result", toolName: "session", toolCallId: `call-${index}`, isError: false },
	]);
	return {
		caseId: id, model: "fixture", projectDir: "/missing", stdout: "", stderr: "",
		exitCode: 0, timedOut: false, events,
		metrics: deriveMetrics({ events, elapsedMs: 1, changedFiles: [], projectDir: "/missing", sessionDir: "/missing" }),
		assertions: [], passed: false,
	};
}

describe("session live eval controls", () => {
	test("covers all five actions and both name modes with unique IDs", () => {
		expect(SESSION_EVAL_CASES.map((evalCase) => evalCase.id).sort()).toEqual(Object.keys(INPUTS).sort());
	});
	for (const evalCase of SESSION_EVAL_CASES) {
		test(`${evalCase.id}: accepts successful calls`, () => {
			expect(evaluateAssertions(evalCase, makeResult(evalCase.id)).every((assertion) => assertion.passed)).toBe(true);
		});
		test(`${evalCase.id}: rejects narration without calls`, () => {
			const result = makeResult(evalCase.id);
			result.stdout = "Done; I performed the requested session operation.";
			result.events = [];
			expect(evalCase.validate!(result).length).toBeGreaterThan(0);
		});
		test(`${evalCase.id}: rejects wrong action or tool`, () => {
			const result = makeResult(evalCase.id);
			result.events[0]!.input = { action: "wrong" };
			expect(evalCase.validate!(result).length).toBeGreaterThan(0);
			result.events[0]!.input = INPUTS[evalCase.id]![0];
			result.events[0]!.toolName = "session_overview";
			expect(evalCase.validate!(result).length).toBeGreaterThan(0);
		});
		test(`${evalCase.id}: rejects missing, failed, mismatched, or duplicate results`, () => {
			for (const change of ["missing", "failed", "mismatched", "duplicate"]) {
				const result = makeResult(evalCase.id);
				if (change === "missing") result.events.splice(1, 1);
				if (change === "failed") result.events[1]!.isError = true;
				if (change === "mismatched") result.events[1]!.toolCallId = "other-call";
				if (change === "duplicate") result.events.push({ ...result.events[1]! });
				expect(evalCase.validate!(result).length, change).toBeGreaterThan(0);
			}
		});
		test(`${evalCase.id}: rejects extra calls`, () => {
			const result = makeResult(evalCase.id);
			result.events.push({ type: "tool_call", toolName: "shell", input: { command: "pwd" } });
			expect(evalCase.validate!(result).length).toBeGreaterThan(0);
		});
	}

	test("checks action-specific arguments instead of only tool names", () => {
		const invalidInputs: Record<string, Record<string, unknown>> = {
			"tool.session-name-set": { action: "name", name: "Wrong title" },
			"tool.session-name-read": { action: "name", name: "Unrequested rename" },
			"tool.session-recovery-read": { action: "read" },
			"tool.session-recovery-search": { action: "search", query: "different phrase" },
			"tool.session-recovery-signals": { action: "recovery", recent_error_limit: 20 },
		};
		for (const [id, input] of Object.entries(invalidInputs)) {
			const evalCase = SESSION_EVAL_CASES.find((candidate) => candidate.id === id)!;
			const result = makeResult(id);
			result.events[result.events.length - 2]!.input = input;
			expect(evalCase.validate!(result).length, id).toBeGreaterThan(0);
		}
	});

	test("rejects recovery/read before mapping and blank or ambiguous read targets", () => {
		for (const id of ["tool.session-recovery-read", "tool.session-recovery-signals"]) {
			const evalCase = SESSION_EVAL_CASES.find((candidate) => candidate.id === id)!;
			const result = makeResult(id);
			result.events = [...result.events.slice(2), ...result.events.slice(0, 2)];
			expect(evalCase.validate!(result).length).toBeGreaterThan(0);
			const parallel = makeResult(id);
			parallel.events = [parallel.events[0]!, parallel.events[2]!, parallel.events[1]!, parallel.events[3]!];
			expect(evalCase.validate!(parallel).length).toBeGreaterThan(0);
		}
		const readCase = SESSION_EVAL_CASES.find((candidate) => candidate.id === "tool.session-recovery-read")!;
		for (const input of [{ entry_id: " " }, { entry_id: "one", section_id: "two" }, { cursor: "unknown" }]) {
			const result = makeResult(readCase.id);
			result.events[2]!.input = { action: "read", ...input };
			expect(readCase.validate!(result).length).toBeGreaterThan(0);
		}
		const result = makeResult(readCase.id);
		result.events[2]!.input = { action: "read", section_id: "mapped-section" };
		expect(readCase.validate!(result)).toEqual([]);
	});
});
