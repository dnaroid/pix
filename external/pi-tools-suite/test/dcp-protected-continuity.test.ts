import { describe, expect, test } from "bun:test";
import { loadConfig } from "../src/dcp/config.js";
import { repeatableObservationKey, toolRecordContinuity } from "../src/dcp/protected-continuity.js";
import { isToolRecordPruningProtected } from "../src/dcp/pruner-tools.js";
import { createState, type ToolRecord } from "../src/dcp/state.js";
import { budgetProtectedToolFragments } from "../src/dcp/continuity-ledger.js";

function record(overrides: Partial<ToolRecord> = {}): ToolRecord {
	return { toolCallId: "call-1", toolName: "shell", inputArgs: { command: "git status --short" },
		inputFingerprint: "shell::fixture", isError: false, turnIndex: 0, timestamp: 1,
		tokenEstimate: 5000, outputText: "M dist/a.js\n".repeat(3_000), ...overrides };
}
const config = () => loadConfig({ homeDir: "/__dcp_protected_continuity__" });

describe("DCP fact retention", () => {
	test("no implicit exact tools; explicit user tags are enabled", () => {
		expect(config().compress.protectedTools).toEqual([]);
		expect(config().compress.protectTags).toBe(true);
	});
	test("observations of any size need no exact ledger", () => {
		for (const outputText of ["clean\n", "observation\n".repeat(10_000)]) {
			for (const source of [record({ outputText }), record({ toolName: "read", inputArgs: { path: "a.ts" }, outputText })]) {
				expect(isToolRecordPruningProtected(source, config())).toBe(false);
				expect(toolRecordContinuity(source, config()).mode).toBe("none");
			}
		}
	});
	test("mutations and unknown tools cannot be deleted without replacement", () => {
		for (const toolName of ["write", "edit", "apply_patch", "ast_apply", "send_email", "paid_request", "unknown_extension"]) {
			const source = record({ toolName, inputArgs: { path: "a.ts" }, outputText: "ok" });
			expect(isToolRecordPruningProtected(source, config())).toBe(true);
			const result = toolRecordContinuity(source, config());
			expect(result.mode).toBe("receipt");
			expect(result.minimumText).toContain("tool:call-1");
			expect(result.sourceHash).toMatch(/^[0-9a-f]{64}$/);
		}
	});
	test("even tiny unknown shell results are receipts, not exact pins", () => {
		const result = toolRecordContinuity(record({ inputArgs: { command: "node publish.mjs" }, outputText: "ok" }), config());
		expect(result.mode).toBe("receipt");
		expect(result.minimumText).toContain("effect UNKNOWN");
		expect(result.minimumText).toContain("Do not repeat blindly");
	});
	test("explicit tool and file pins stay exact, independently of action protection", () => {
		const cfg = config(); cfg.compress.protectedTools = ["read", "write"];
		for (const toolName of ["read", "write"]) {
			expect(toolRecordContinuity(record({ toolName, outputText: "EXACT" }), cfg)).toMatchObject({ mode: "verbatim", text: `### Tool: ${toolName}\nEXACT` });
		}
		cfg.compress.protectedTools = []; cfg.protectedFilePatterns = ["secrets/**"];
		expect(toolRecordContinuity(record({ inputArgs: { command: "git status", cwd: "secrets/repo" } }), cfg).mode).toBe("verbatim");
	});
	test("external effects retain IDs, unknown outcomes and recovery links", () => {
		const result = toolRecordContinuity(record({ toolName: "publish", isError: true,
			outputText: "Timeout after sending request\noperation_id: remote-42\nlog: .pi/artifacts/run/log.txt",
			outputDetails: { requestId: "request-1", status: "pending" } }), config());
		for (const fact of ["effect UNKNOWN", "remote-42", "request-1", "pending", ".pi/artifacts/run/log.txt", "Timeout"]) {
			expect(result.minimumText).toContain(fact);
		}
	});
	test("missing outcome never becomes mutation success", () => {
		expect(toolRecordContinuity(record({ toolName: "write", outputText: undefined }), config()).minimumText).toContain("UNKNOWN; result not observed");
	});
	test("plain JSON action receipts retain IDs and status without structured details", () => {
		const result = toolRecordContinuity(record({ toolName: "publish", inputArgs: {}, outputText: '{"id":"remote-42","status":"pending"}' }), config());
		expect(result.minimumText).toContain("remote-42");
		expect(result.minimumText).toContain("pending");
	});
	test("successful mutation receipts do not drop reported diagnostic failures", () => {
		const result = toolRecordContinuity(record({ toolName: "write", inputArgs: { path: "src/a.ts" }, outputText: "Written successfully.\nsrc/a.ts:1 error: cannot find module" }), config());
		expect(result.minimumText).toContain("cannot find module");
	});
	test("one-line JSON references do not pin the adjacent raw transcript", () => {
		const result = toolRecordContinuity(record({ toolName: "codemode", inputArgs: {}, outputText: JSON.stringify({
			id: "remote-42", status: "pending", log: ".pi/artifacts/run/log.txt", output: "raw-observation ".repeat(10_000),
		}) }), config());
		expect(result.minimumText).toContain("remote-42");
		expect(result.minimumText).toContain("pending");
		expect(result.minimumText).toContain(".pi/artifacts/run/log.txt");
		expect(result.minimumText).not.toContain("raw-observation");
		expect(result.minimumText!.length).toBeLessThan(1_000);
	});
	test("mutation receipts retain attempted paths and producer summary", () => {
		const result = toolRecordContinuity(record({ toolName: "apply_patch", inputArgs: { patch: "*** Update File: src/a.ts" },
			outputText: "Success\nM src/b.ts\n" + "diagnostic detail\n".repeat(1_000),
			outputDetails: { changedFiles: ["src/c.ts"], summary: "Updated three files" } }), config());
		for (const path of ["src/a.ts", "src/b.ts", "src/c.ts"]) expect(result.minimumText).toContain(path);
		expect(result.text).toContain("Updated three files");
		expect(result.text!.length).toBeLessThan(1_000);
	});
	test("test results retain historical outcome and actionable failures, never newest-wins", () => {
		const output = ["bun test v1.3.14 (0d9b296a)", "(fail) a.test.ts > contract [2.00ms]", "Error: expected marker", " 25 pass", " 1 fail", "Ran 26 tests across 1 file. [7.00ms]"].join("\n");
		const source = record({ inputArgs: { command: "bun test test/a.test.ts" }, outputText: output, isError: true });
		const result = toolRecordContinuity(source, config());
		expect(result.mode).toBe("digest");
		expect(result.minimumText).toContain("Execution outcome: ERROR");
		expect(result.minimumText).toContain("expected marker");
		expect(result.minimumText).toContain("25 passed, 1 failed, 26 tests, 1 files");
		expect(result.minimumText).toContain("Not current verification");
		expect(repeatableObservationKey(source, config())).toBeUndefined();
	});
	test("unparsed test output is never implicitly exact", () => {
		const result = toolRecordContinuity(record({ inputArgs: { command: "bun test test/a.test.ts" }, outputText: "FAILED: custom runner", isError: true }), config());
		expect(result.mode).toBe("digest");
		expect(result.minimumText).toContain("custom runner");
	});
	test("several substantial test logs fit the default floor without dropping per-run facts", () => {
		const fragments = Array.from({ length: 8 }, (_, index) => {
			const outputText = ["bun test v1.3.14", ...Array.from({ length: 40 }, (_, n) => `Error: case ${n} ${"detail ".repeat(15)}`), " 25 pass", " 1 fail", "Ran 26 tests across 1 file. [7.00ms]"].join("\n");
			const decision = toolRecordContinuity(record({ toolCallId: `test-${index}`, inputArgs: { command: "bun test" }, outputText, isError: true }), config());
			return { kind: "tool" as const, origin: `tool:test-${index}`, hash: decision.sourceHash, text: decision.text!, minimumText: decision.minimumText,
				representation: "digest" as const, policyVersion: 3 as const, sourceHash: decision.sourceHash };
		});
		const budgeted = budgetProtectedToolFragments(fragments, createState(), config());
		expect(budgeted).toHaveLength(8);
		for (const [index, fragment] of budgeted.entries()) {
			expect(fragment.text).toContain(`tool:test-${index}`);
			expect(fragment.text).toContain("25 passed, 1 failed, 26 tests");
			expect(fragment.text).toContain("Error: case 0");
			expect(fragment.text).toContain("additional diagnostics omitted; recover source");
		}
	});
	test("compress and todo history are runtime-owned; subagent spawn keeps recovery evidence", () => {
		for (const toolName of ["compress", "todo"]) expect(toolRecordContinuity(record({ toolName }), config()).mode).toBe("none");
		expect(toolRecordContinuity(record({ toolName: "subagents", inputArgs: { action: "result" } }), config()).mode).toBe("none");
		const result = toolRecordContinuity(record({ toolName: "subagents", inputArgs: { action: "spawn" }, outputDetails: { agentId: "a1", runDir: ".pi/subagents/run" } }), config());
		expect(result.minimumText).toContain("a1"); expect(result.minimumText).toContain(".pi/subagents/run");
	});
});
