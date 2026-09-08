import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

import { evaluateAssertions } from "./harness/assertions.js";
import { deriveMetrics } from "./harness/metrics.js";
import { renderEvalReportMarkdown } from "./harness/report.js";
import { writeRecorder } from "./harness/runner.js";
import type { EvalCase, EvalEvent, EvalReport } from "./harness/types.js";
import { readRecoveryProbeEvents } from "./recovery-provenance.js";

describe("eval harness", () => {
	test("derives mutation and behavioral verification metrics from tool events", () => {
		const events: EvalEvent[] = [
			{ type: "tool_call", toolName: "shell", input: { command: "npm test" } },
			{ type: "tool_result", toolName: "shell", isError: true, contentBytes: 30, textBytes: 20 },
			{ type: "tool_call", toolName: "apply_patch", input: { input: "patch" } },
			{ type: "tool_result", toolName: "apply_patch", isError: false, contentBytes: 40, textBytes: 35 },
			{ type: "tool_call", toolName: "shell", input: { command: "npm test" } },
			{ type: "tool_result", toolName: "shell", isError: false, contentBytes: 50, textBytes: 45 },
			{ type: "tool_call", toolCallId: "r1", toolName: "repo_search", input: { target: "fixture" } },
			{ type: "tool_result", toolCallId: "r1", toolName: "repo_search", isError: true, contentBytes: 60, textBytes: 50, nativePolicy: { refused: true, outputMode: "compact", reason: "compact-limit-exceeded" } },
			{ type: "tool_call", toolCallId: "r2", toolName: "repo_search", input: { target: "fixture", outputMode: "full" } },
			{ type: "tool_result", toolCallId: "r2", toolName: "repo_search", isError: false, contentBytes: 70, textBytes: 60, nativePolicy: { refused: false, outputMode: "full" } },
			{
				type: "agent_end",
				usage: { input: 80, output: 20, cacheRead: 5, cacheWrite: 0, totalTokens: 105, cost: 0.01 },
				contextGatewayTelemetry: {
					mode: "observe",
					maxResultBytes: 8192,
					budgets: {
						maxInlineBytes: 8192,
						maxResultBytes: 8192,
						maxExactReadBytes: 32768,
						maxSearchBytes: 8192,
						maxSearchMatches: 12,
					},
					snapshot: {
						version: 1,
						results: 2,
						errors: 0,
						contentBytes: 12_000,
						deliveredContentBytes: 12_000,
						textBytes: 11_000,
						imageBytes: 0,
						detailsBytes: 100,
						upstreamTruncatedResults: 1,
						overBudgetResults: 1,
						potentialBytesOverBudget: 3_808,
						enforcedResults: 0,
						actualBytesSaved: 0,
						pendingCalls: 0,
						unboundResults: 0,
						repeatCandidateCount: 0,
						sameSourceDifferentRangeCount: 0,
						retrievalCalls: 0,
						nativePolicy: { results: 0, refusals: 0, fullOverrides: 0, byReason: {} },
						testOutput: {
							parserVersion: 1,
							results: 0,
							scanLimitedResults: 0,
							compactCandidates: 0,
							passthroughRecommended: 0,
							byClassification: { recognised: 0, partial: 0, unrecognised: 0 },
							byFormat: { "bun-test": 0, tap: 0, typescript: 0, mixed: 0, unknown: 0 },
						},
						byClass: {},
					},
				},
			},
		];
		const metrics = deriveMetrics({ events, elapsedMs: 1234, changedFiles: ["src/a.ts"], projectDir: "/missing", sessionDir: "/missing" });
		expect(metrics.toolCallCount).toBe(5);
		expect(metrics.mutationCount).toBe(1);
		expect(metrics.verificationCount).toBe(2);
		expect(metrics.failedToolResults).toBe(2);
		expect(metrics.toolResultContentBytes).toBe(250);
		expect(metrics.toolResultTextBytes).toBe(210);
		expect(metrics.repoResultContentBytes).toBe(130);
		expect(metrics.nativePolicyResults).toBe(2);
		expect(metrics.nativePolicyRefusals).toBe(1);
		expect(metrics.nativePolicyFullOverrides).toBe(1);
		expect(metrics.retryAfterNativeRefusalCount).toBe(1);
		expect(metrics.changedFiles).toEqual(["src/a.ts"]);
		expect(metrics.parentUsage.totalTokens).toBe(105);
		expect(metrics.parentUsage.cost).toBe(0.01);
		expect(metrics.contextGateway?.mode).toBe("observe");
		expect(metrics.contextGateway?.snapshot.upstreamTruncatedResults).toBe(1);
		expect(metrics.contextGateway?.snapshot.potentialBytesOverBudget).toBe(3_808);
	});

	test("generated recorder uses shared Context Gateway telemetry without copying raw bodies or args into its snapshot", async () => {
		const root = mkdtempSync(join(tmpdir(), "context-gateway-eval-recorder-"));
		const previousCwd = process.cwd();
		const previousMode = process.env.PI_CONTEXT_GATEWAY_MODE;
		const previousHome = process.env.HOME;
		const previousConfigDir = process.env.PI_CONFIG_DIR;
		try {
			process.chdir(root);
			process.env.HOME = root;
			process.env.PI_CONFIG_DIR = join(root, "config");
			process.env.PI_CONTEXT_GATEWAY_MODE = "observe";
			const recorder = writeRecorder(root, []);
			const module = await import(`${recorder.extensionPath}?test=${Date.now()}`);
			const handlers = new Map<string, any[]>();
			module.default({
				on(name: string, handler: any) {
					handlers.set(name, [...(handlers.get(name) ?? []), handler]);
				},
			});

			await handlers.get("tool_call")![0]({
				toolCallId: "read-observe",
				toolName: "Read",
				input: { path: "PRIVATE_RECORDER_ARG.ts" },
			});
			await handlers.get("tool_result")![0]({
				toolCallId: "read-observe",
				toolName: "Read",
				content: [{ type: "text", text: `PRIVATE_RECORDER_BODY_${"x".repeat(9_000)}` }],
				details: { truncation: { truncated: true }, privatePath: "PRIVATE_RECORDER_ARG.ts" },
				isError: false,
			});
			await handlers.get("agent_end")![0]({ messages: [] });

			const events = readFileSync(recorder.logPath, "utf8")
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line));
			const snapshot = events.at(-1)?.contextGatewayTelemetry?.snapshot;
			const budgets = events.at(-1)?.contextGatewayTelemetry?.budgets;
			expect(snapshot?.results).toBe(1);
			expect(snapshot?.upstreamTruncatedResults).toBe(1);
			expect(snapshot?.overBudgetResults).toBe(0);
			expect(snapshot?.lastObservation?.budgetBytes).toBe(32_768);
			expect(budgets?.maxExactReadBytes).toBe(32_768);
			expect(snapshot?.byClass?.["code-read"]?.results).toBe(1);
			const serializedSnapshot = JSON.stringify(snapshot);
			expect(serializedSnapshot).not.toContain("PRIVATE_RECORDER_ARG.ts");
			expect(serializedSnapshot).not.toContain("PRIVATE_RECORDER_BODY");
		} finally {
			process.chdir(previousCwd);
			if (previousMode === undefined) delete process.env.PI_CONTEXT_GATEWAY_MODE;
			else process.env.PI_CONTEXT_GATEWAY_MODE = previousMode;
			if (previousHome === undefined) delete process.env.HOME;
			else process.env.HOME = previousHome;
			if (previousConfigDir === undefined) delete process.env.PI_CONFIG_DIR;
			else process.env.PI_CONFIG_DIR = previousConfigDir;
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("generated recorder can remove only declared in-project fixture files after a tool result", async () => {
		const root = mkdtempSync(join(tmpdir(), "eval-recorder-cleanup-"));
		const fixture = join(root, "fixture.txt");
		const nativeFullOutput = join(root, ".pi", "native-full.log");
		writeFileSync(fixture, "fixture", "utf8");
		try {
			const expectedFact = "RECOVERY_PROBE_FACT=opaque-value";
			mkdirSync(join(root, ".pi"), { recursive: true });
			writeFileSync(nativeFullOutput, `${expectedFact}\nrest\n`, "utf8");
			const recorder = writeRecorder(root, [], { bash: ["fixture.txt"] }, {
				expectedFact,
				producerToolNames: ["Bash"],
			});
			const module = await import(`${recorder.extensionPath}?cleanup=${Date.now()}`);
			const handlers = new Map<string, any[]>();
			module.default({
				on(name: string, handler: any) {
					handlers.set(name, [...(handlers.get(name) ?? []), handler]);
				},
			});
			expect(existsSync(fixture)).toBe(true);
			await handlers.get("tool_result")![0]({
				toolCallId: "cleanup",
				toolName: "Bash",
				content: [{ type: "text", text: "bounded tail" }],
				details: { fullOutputPath: nativeFullOutput },
				isError: false,
			});
			expect(existsSync(fixture)).toBe(false);
			const probes = readRecoveryProbeEvents(root);
			expect(probes).toHaveLength(1);
			expect(probes[0]).toMatchObject({
				toolCallId: "cleanup",
				toolName: "Bash",
				fullOutputPath: nativeFullOutput,
				fullOutputFactStatus: "match",
				cleanupExpectedCount: 1,
				cleanupExistingBeforeCount: 1,
				cleanupDeletedCount: 1,
				cleanupMissingAfterCount: 1,
			});
			const ordinaryLog = readFileSync(recorder.logPath, "utf8");
			expect(ordinaryLog).not.toContain(nativeFullOutput);
			expect(ordinaryLog).not.toContain(expectedFact);
			expect(() => writeRecorder(root, [], { bash: ["../escape.txt"] })).toThrow("escapes project root");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("enforces reproduce-before-edit and verify-after-edit workflow assertions", () => {
		const evalCase: EvalCase = {
			id: "workflow",
			category: "coding-quality",
			description: "workflow",
			fixture: "demo",
			prompt: "workflow",
			assert: { requireReproBeforeMutation: true, requireVerificationAfterMutation: true },
		};
		const events: EvalEvent[] = [
			{ type: "tool_call", toolName: "shell", input: { command: "npm test" } },
			{ type: "tool_call", toolName: "apply_patch", input: { input: "patch" } },
			{ type: "tool_call", toolName: "shell", input: { command: "npm test" } },
		];
		const metrics = deriveMetrics({ events, elapsedMs: 1, changedFiles: ["src/a.ts"], projectDir: "/missing", sessionDir: "/missing" });
		const assertions = evaluateAssertions(evalCase, {
			caseId: evalCase.id,
			model: "test/model",
			projectDir: "/missing",
			stdout: "",
			stderr: "",
			exitCode: 0,
			timedOut: false,
			events,
			metrics,
		});
		expect(assertions.filter((item) => !item.passed)).toEqual([]);
	});

	test("renders comparable model/token/cost report", () => {
		const report: EvalReport = {
			startedAt: "2026-01-01T00:00:00.000Z",
			finishedAt: "2026-01-01T00:00:01.000Z",
			models: ["zai/glm-5.3"],
			results: [{
				caseId: "case",
				model: "zai/glm-5.3",
				projectDir: "/tmp/case",
				stdout: "",
				stderr: "",
				exitCode: 0,
				timedOut: false,
				events: [],
				metrics: {
					elapsedMs: 1000,
					toolCallCount: 2,
					toolCalls: ["repo_search", "read"],
					failedToolResults: 0,
					toolResultContentBytes: 1200,
					toolResultTextBytes: 1000,
					repoResultContentBytes: 900,
					nativePolicyResults: 2,
					nativePolicyRefusals: 1,
					nativePolicyFullOverrides: 1,
					retryAfterNativeRefusalCount: 1,
					mutationCount: 0,
					verificationCount: 0,
					changedFiles: [],
					parentUsage: { input: 80, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 100, cost: 0.01 },
					subagentUsage: { input: 40, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 50, cost: 0.002 },
					subagentCount: 1,
				},
				assertions: [],
				passed: true,
			}],
		};
		const markdown = renderEvalReportMarkdown(report);
		expect(markdown).toContain("zai/glm-5.3");
		expect(markdown).toContain("100");
		expect(markdown).toContain("50");
		expect(markdown).toContain("$0.0120");
		expect(markdown).toContain("1200");
		expect(markdown).toContain("2/1/1/1");
	});
});
