import { describe, expect, test } from "bun:test";
import { loadConfig } from "../../src/dcp/config.js";

import {
	analyzeSessionJsonlText,
	measureDcpCarrierOverhead,
	measureDcpControlPlane,
} from "./session-token-efficiency.js";

function line(entry: unknown): string {
	return JSON.stringify(entry);
}

describe("session token-efficiency analysis", () => {
	test("separates provider usage, DCP projection, tool telemetry, and repeated reads", () => {
		const fixture = [
			line({ type: "session", version: 3, id: "s1", timestamp: "2026-09-08T00:00:00Z", cwd: "/tmp/demo" }),
			line({
				type: "message",
				message: {
					role: "assistant",
					usage: {
						input: 100,
						cacheRead: 200,
						cacheWrite: 5,
						output: 30,
						reasoning: 7,
						totalTokens: 335,
						cost: { input: 1, cacheRead: 2, cacheWrite: 0.1, output: 3, total: 6.1 },
					},
					content: [{ type: "toolCall", id: "r1", name: "read", arguments: { path: "a.ts", offset: 1, limit: 20 } }],
				},
			}),
			line({ type: "message", message: { role: "toolResult", toolCallId: "r1", toolName: "read", content: [{ type: "text", text: "x".repeat(9_000) }], details: {}, isError: false } }),
			line({ type: "message", message: { role: "assistant", usage: { input: 10, cacheRead: 20, cacheWrite: 0, output: 3, reasoning: 0, totalTokens: 33, cost: { total: 0.2 } }, content: [{ type: "toolCall", id: "r2", name: "read", arguments: { path: "a.ts", offset: 1, limit: 20 } }] } }),
			line({ type: "message", message: { role: "toolResult", toolCallId: "r2", toolName: "read", content: [{ type: "text", text: "same" }], details: {}, isError: false } }),
			line({ type: "custom", customType: "dcp-journal", data: { kind: "delta", blocks: [{ id: 1, active: true, summary: "summary", summaryTokenEstimate: 2, coveredBlockIds: [], protectedFragments: [{ text: "kept" }] }] } }),
			line({ type: "message", message: { role: "toolResult", toolCallId: "c1", toolName: "compress", content: [{ type: "text", text: "{}" }], details: { committed: true, projectedBeforeTokens: 1000, projectedAfterTokens: 400, netGain: 600, totalSummaryTokens: 100, prunedTools: 0 }, isError: false } }),
		].join("\n");

		const report = analyzeSessionJsonlText(fixture);
		expect(report.usage).toMatchObject({
			assistantCalls: 2,
			input: 110,
			cacheRead: 220,
			cacheWrite: 5,
			promptTokenOccurrences: 335,
			output: 33,
		});
		expect(report.tools).toMatchObject({ calls: 2, results: 3, errors: 0 });
		expect(report.contextGateway.repeatCandidateCount).toBe(1);
		expect(report.contextGateway.overBudgetResults).toBe(0);
		expect(report.contextGateway.lastObservation?.budgetBytes).toBe(32768);
		expect(report.dcp.blocks[0]).toMatchObject({
			id: 1,
			summaryChars: 7,
			protectedFragmentCount: 1,
			protectedFragmentChars: 4,
		});
		expect(report.dcp.compressResults[0]).toMatchObject({
			committed: true,
			projectedBeforeTokens: 1000,
			projectedAfterTokens: 400,
			netGain: 600,
		});
	});

	test("can project protected continuity savings from journal tool-fragment provenance", () => {
		const config = loadConfig({ homeDir: "/__efficiency_fixture__" });
		const output = "large status output\n".repeat(1_000);
		const protectedText = `### Tool: shell\n${output}`;
		const fixture = [
			line({ type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "s1", name: "shell", arguments: { command: "git status --short" } }] } }),
			line({ type: "message", message: { role: "toolResult", toolCallId: "s1", toolName: "shell", content: [{ type: "text", text: output }], isError: false } }),
			line({ type: "custom", customType: "dcp-journal", data: { kind: "delta", blocks: [{ id: 1, active: true, summary: protectedText, summaryTokenEstimate: 1, protectedFragments: [{ kind: "tool", origin: "tool:s1", hash: "fixture", text: protectedText }] }] } }),
		].join("\n");
		const report = analyzeSessionJsonlText(fixture, { dcpConfig: config });
		expect(report.dcp.continuityProjection?.toolFragments).toBe(1);
		expect(report.dcp.continuityProjection?.byMode.digest).toBe(1);
		expect(report.dcp.continuityProjection?.reductionPercent ?? 0).toBeGreaterThan(90);
		expect(report.dcp.continuityProjection?.activeSummaryTokenReduction ?? 0).toBeGreaterThan(0);
	});

	test("control-plane accounting exposes independently budgetable components", () => {
		const measured = measureDcpControlPlane();
		expect(measured.components.systemPrompt.estimatedTokens).toBeGreaterThan(0);
		expect(measured.components.compressDescription.estimatedTokens).toBeGreaterThan(0);
		expect(measured.components.compressSchema.estimatedTokens).toBeGreaterThan(0);
		expect(measured.components.turnNudge.estimatedTokens).toBeGreaterThan(0);
		expect(measured.staticSystemPlusToolEnvelope.estimatedTokens)
			.toBeGreaterThan(measured.components.systemPrompt.estimatedTokens);
		// Regression budgets are derived from the reference-session baseline:
		// system=527, description=2005, static system+tool=3061,
		// turn=293, iteration=252 estimated tokens.
		expect(measured.components.systemPrompt.estimatedTokens).toBeLessThanOrEqual(325);
		expect(measured.components.compressDescription.estimatedTokens).toBeLessThanOrEqual(1203);
		// Cheap explicit-summary delegation must not reintroduce a permanent
		// control-plane tax. The complete post-follow-up envelope is currently
		// 1,324 estimated tokens; keep that measured baseline as the hard ceiling.
		expect(measured.staticSystemPlusToolEnvelope.estimatedTokens).toBeLessThanOrEqual(1324);
		expect(measured.components.turnNudge.estimatedTokens).toBeLessThanOrEqual(205);
		expect(measured.components.iterationNudge.estimatedTokens).toBeLessThanOrEqual(176);
	});

	test("carrier accounting measures distributed message-ID overhead separately", () => {
		const measured = measureDcpCarrierOverhead([
			{ role: "user", id: "u1", timestamp: 1, content: [{ type: "text", text: "request" }] },
			{ role: "assistant", id: "a1", timestamp: 2, content: [{ type: "text", text: "working" }] },
			{ role: "toolResult", id: "t1", toolCallId: "tc1", toolName: "read", timestamp: 3, content: [{ type: "text", text: "result" }] },
		]);
		expect(measured.messages).toBe(3);
		expect(measured.carriers).toBe(2);
		expect(measured.overheadEstimatedTokens).toBeGreaterThan(0);
		expect(measured.withCarrierEstimatedTokens).toBeGreaterThan(measured.rawEstimatedTokens);
		expect(measured.legacyEquivalentOverheadEstimatedTokens).toBeGreaterThan(measured.overheadEstimatedTokens);
		expect(measured.reductionVsLegacyPercent).toBeGreaterThan(50);
	});

	test("measures parent-output opportunity from historical explicit compress summaries", () => {
		const summary = "continuation fact ".repeat(240);
		const fixture = [
			line({
				type: "message",
				message: {
					role: "assistant",
					usage: { input: 10, cacheRead: 20, cacheWrite: 0, output: 1200, totalTokens: 1230, cost: { total: 0.1 } },
					content: [{
						type: "toolCall",
						id: "compress-1",
						name: "compress",
						arguments: {
							topic: "old work",
							ranges: [{ startId: "m001", endId: "m050", summary }],
						},
					}],
				},
			}),
		].join("\n");

		const report = analyzeSessionJsonlText(fixture);
		expect(report.dcp.manualSummaryDelegation).toMatchObject({
			compressCalls: 1,
			compressAssistantCalls: 1,
			compressAssistantOutputTokens: 1200,
			summaryArgumentChars: summary.length,
		});
		expect(report.dcp.manualSummaryDelegation.summaryArgumentEstimatedTokens).toBeGreaterThan(0);
		expect(report.dcp.manualSummaryDelegation.estimatedArgumentTokenReduction).toBeGreaterThan(0);
		expect(report.dcp.manualSummaryDelegation.argumentEstimatedTokensWithoutSummaries)
			.toBeLessThan(report.dcp.manualSummaryDelegation.argumentEstimatedTokensBefore);
	});

	test("separates ingress savings, DCP history gain, and unattributed post-reduction read candidates", () => {
		const fixture = [
			line({ type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "r1", name: "read", arguments: { path: "./src/../src/a.ts", offset: 1, limit: 10 } }] } }),
			line({ type: "message", message: { role: "toolResult", toolCallId: "r1", toolName: "read", content: [{ type: "text", text: "before" }], details: {}, isError: false } }),
			line({ type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "compress", arguments: { topic: "fixture" } }] } }),
			line({ type: "message", message: { role: "toolResult", toolCallId: "c1", toolName: "compress", content: [{ type: "text", text: "{}" }], details: { committed: true, netGain: 100 }, isError: false } }),
			line({ type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "r2", name: "Read", arguments: { path: "src/a.ts", offset: "1", limit: "10" } }] } }),
			line({ type: "message", message: { role: "toolResult", toolCallId: "r2", toolName: "Read", content: [{ type: "text", text: "after" }], details: {}, isError: false } }),
			line({ type: "message", message: { role: "toolResult", toolCallId: "gateway", toolName: "Bash", content: [{ type: "text", text: "compact" }], details: { contextGateway: { version: 1, representation: "test-build-compact", sourceContentBytes: 1000, deliveredContentBytes: 100 } }, isError: false } }),
			line({ type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "r3", name: "read", arguments: { path: "src/a.ts", offset: 11, limit: 10 } }] } }),
			line({ type: "message", message: { role: "toolResult", toolCallId: "r3", toolName: "read", content: [{ type: "text", text: "later range" }], details: {}, isError: false } }),
		].join("\n");

		const report = analyzeSessionJsonlText(fixture);
		expect(report.accounting.ingressAvoidedBytes).toBe(900);
		expect(report.accounting.historyCompressionGainTokens).toBe(100);
		expect(report.accounting.recoveryTax).toEqual({
			exactRepeatReadsAfterContextReduction: 1,
			sameSourceDifferentRangeReadsAfterContextReduction: 1,
			unattributedCandidates: 2,
			likelyRecoveryTaxReads: 0,
		});
	});
});
