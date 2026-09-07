import { describe, expect, test } from "bun:test";

import { parseTestBuildOutput, planProspectiveTestOutputDelivery } from "../../src/context-gateway/test-output-parser.js";

const BUN_SUCCESS = `bun test v1.3.14 (0d9b296a)
(pass) src/a.test.ts > alpha [1.00ms]
(pass) src/a.test.ts > beta [1.00ms]

 2 pass
 0 fail
 4 expect() calls
Ran 2 tests across 1 file. [12.00ms]`;

const BUN_FAILURE = `bun test v1.3.14 (0d9b296a)
(pass) src/payments.test.ts > prepares payment [1.00ms]
(fail) src/payments.test.ts > rejects duplicate payment [2.00ms]
error: expected duplicate request to be rejected
Warning: retry fixture used a legacy code path
(pass) src/payments.test.ts > preserves audit event [1.00ms]

 2 pass
 1 fail
 9 expect() calls
Ran 3 tests across 1 file. [20.00ms]
Command exited with code 1`;

const TAP_FAILURE = `TAP version 13
ok 1 - alpha
not ok 2 - beta
  error: expected 2 to equal 3
  operator: equal
1..2
# tests 2
# pass 1
# fail 1
Command exited with code 1`;

const TSC_FAILURE = `src/payments.ts(10,5): error TS2322: Type 'string' is not assignable to type 'number'.
src/cart.ts(4,1): warning TS6133: 'unused' is declared but its value is never read.
Found 1 error in 1 file.
Command exited with code 2`;

describe("P01-R R-D pure test/build parser", () => {
	test("recognises a complete Bun success terminal summary without inventing diagnostics", () => {
		const parsed = parseTestBuildOutput({ text: BUN_SUCCESS, hostOutcome: "success" });
		expect(parsed).toMatchObject({
			classification: "recognised",
			format: "bun-test",
			hostOutcome: "success",
			terminalSummarySeen: true,
			summary: { passed: 2, failed: 0, tests: 2, files: 1 },
			diagnostics: [],
			parserWarnings: [],
		});
	});

	test("keeps exact middle Bun failure/warning lines and accepts the host nonzero status after the terminal summary", () => {
		const parsed = parseTestBuildOutput({ text: BUN_FAILURE, hostOutcome: "error" });
		expect(parsed.classification).toBe("recognised");
		expect(parsed.summary).toEqual({ passed: 2, failed: 1, tests: 3, files: 1 });
		expect(parsed.diagnostics).toContainEqual({ severity: "error", text: "(fail) src/payments.test.ts > rejects duplicate payment [2.00ms]" });
		expect(parsed.diagnostics).toContainEqual({ severity: "error", text: "error: expected duplicate request to be rejected" });
		expect(parsed.diagnostics).toContainEqual({ severity: "warning", text: "Warning: retry fixture used a legacy code path" });
	});

	test("does not turn PASS-before-exit-1 into a successful complete test run", () => {
		const text = `${BUN_SUCCESS}\nCommand exited with code 1`;
		const parsed = parseTestBuildOutput({ text, hostOutcome: "error" });
		expect(parsed.classification).toBe("partial");
		expect(parsed.parserWarnings).toContain("host-outcome-conflict");
		expect(planProspectiveTestOutputDelivery(parsed, 8_192)).toMatchObject({ decision: "passthrough", reason: "parser-not-complete" });
	});

	test("marks an otherwise valid summary partial when the SDK result is upstream-truncated or timed out", () => {
		const truncated = parseTestBuildOutput({ text: BUN_SUCCESS, hostOutcome: "success", upstreamTruncated: true });
		expect(truncated.classification).toBe("partial");
		expect(truncated.parserWarnings).toContain("upstream-truncated");
		expect(planProspectiveTestOutputDelivery(truncated, 8_192).reason).toBe("upstream-truncated");

		const timeout = parseTestBuildOutput({
			text: `${BUN_SUCCESS}\nCommand timed out after 3 seconds`,
			hostOutcome: "error",
		});
		expect(timeout.classification).toBe("partial");
		expect(timeout.termination).toBe("timeout");
		expect(planProspectiveTestOutputDelivery(timeout, 8_192).reason).toBe("termination-not-normal");
	});

	test("normalizes ANSI and CR overwrite only for parsing", () => {
		const text = `\u001b[36mbun test v1.3.14\u001b[0m\n0 pass\r2 pass\n0 fail\nRan 2 tests across 1 file. [5.00ms]`;
		const parsed = parseTestBuildOutput({ text, hostOutcome: "success" });
		expect(parsed.classification).toBe("recognised");
		expect(parsed.summary).toEqual({ passed: 2, failed: 0, tests: 2, files: 1 });
	});

	test("recognises TAP only with a terminal plan/count summary and preserves exact failure diagnostics", () => {
		const parsed = parseTestBuildOutput({ text: TAP_FAILURE, hostOutcome: "error" });
		expect(parsed.classification).toBe("recognised");
		expect(parsed.format).toBe("tap");
		expect(parsed.summary).toEqual({ passed: 1, failed: 1, tests: 2 });
		expect(parsed.diagnostics).toContainEqual({ severity: "error", text: "not ok 2 - beta" });
		expect(parsed.diagnostics).toContainEqual({ severity: "error", text: "  error: expected 2 to equal 3" });
	});

	test("recognises bounded TypeScript diagnostic output and refuses pretty/unparsed extra text as complete", () => {
		const parsed = parseTestBuildOutput({ text: TSC_FAILURE, hostOutcome: "error" });
		expect(parsed.classification).toBe("recognised");
		expect(parsed.format).toBe("typescript");
		expect(parsed.summary).toMatchObject({ failed: 1, files: 1 });
		expect(parsed.diagnostics[0]?.text).toContain("TS2322");
		expect(parsed.diagnostics[1]?.severity).toBe("warning");

		const pretty = parseTestBuildOutput({
			text: `src/a.ts:1:7 - error TS2322: Type 'string' is not assignable to type 'number'.\n1 const x: number = 'x';\n        ~\nFound 1 error in src/a.ts:1\nCommand exited with code 2`,
			hostOutcome: "error",
		});
		expect(pretty.classification).toBe("partial");
	});

	test("mixed/nested command formats remain partial instead of attributing the final outcome to the first summary", () => {
		const parsed = parseTestBuildOutput({ text: `${BUN_SUCCESS}\n${TSC_FAILURE}`, hostOutcome: "error" });
		expect(parsed.classification).toBe("partial");
		expect(parsed.format).toBe("mixed");
		expect(parsed.parserWarnings).toContain("mixed-formats");
	});

	test("leaves unknown output unrecognised and never makes a generic head/tail compact candidate", () => {
		const parsed = parseTestBuildOutput({ text: "custom build says maybe fine\nno formal summary", hostOutcome: "success" });
		expect(parsed.classification).toBe("unrecognised");
		expect(parsed.format).toBe("unknown");
		expect(planProspectiveTestOutputDelivery(parsed, 8_192)).toEqual({
			version: 1,
			decision: "passthrough",
			reason: "parser-not-complete",
			bytes: 0,
		});
	});

	test("prospective compact output is all-or-passthrough: mandatory diagnostics are never sliced to fit", () => {
		const parsed = parseTestBuildOutput({ text: BUN_FAILURE, hostOutcome: "error" });
		const candidate = planProspectiveTestOutputDelivery(parsed, 8_192, { commandScope: "simple" });
		expect(candidate.decision).toBe("compact-candidate");
		expect(candidate.text).toContain("Execution outcome: ERROR");
		expect(candidate.text).toContain("error: expected duplicate request to be rejected");
		expect(candidate.text).not.toContain("prepares payment");

		const tooSmall = planProspectiveTestOutputDelivery(parsed, 32, { commandScope: "simple" });
		expect(tooSmall.decision).toBe("passthrough");
		expect(tooSmall.reason).toBe("compact-budget-exceeded");
		expect(tooSmall.text).toBeUndefined();
	});

	test("recognised output still stays passthrough for compound or unknown shell command scope", () => {
		const parsed = parseTestBuildOutput({ text: BUN_SUCCESS, hostOutcome: "success" });
		expect(planProspectiveTestOutputDelivery(parsed, 8_192, { commandScope: "compound" })).toEqual({
			version: 1,
			decision: "passthrough",
			reason: "compound-command",
			bytes: 0,
		});
		expect(planProspectiveTestOutputDelivery(parsed, 8_192)).toEqual({
			version: 1,
			decision: "passthrough",
			reason: "command-scope-unknown",
			bytes: 0,
		});
	});

	test("bounds parser work on huge output and forces passthrough even when head/tail resemble a complete run", () => {
		const huge = `${BUN_SUCCESS.split("Ran 2 tests")[0]}${"middle-noise\n".repeat(20_000)}Ran 2 tests across 1 file. [12.00ms]`;
		const parsed = parseTestBuildOutput({ text: huge, hostOutcome: "success", maxScanChars: 2_000 });
		expect(parsed.scanLimited).toBe(true);
		expect(parsed.classification).toBe("partial");
		expect(parsed.parserWarnings).toContain("scan-limited");
		expect(planProspectiveTestOutputDelivery(parsed, 8_192)).toMatchObject({
			decision: "passthrough",
			reason: "parser-not-complete",
	});
	});
});
