import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { formatDcpStatsToast } from "../src/app/rendering/dcp-stats.js";

describe("formatDcpStatsToast", () => {
	it("derives durable DCP state from the session journal and combines operation gain with prune gain", () => {
		const blocks = Array.from({ length: 25 }, (_, index) => ({ id: index + 1, active: index < 12 }));
		const prunedTools = Array.from({ length: 37 }, (_, index) => ({
			toolCallId: `tool-${index}`,
			reason: "manual-sweep",
			tokenEstimate: index === 0 ? 3_185 : 0,
		}));
		const session = fakeSession({
			usage: { tokens: 206_083, contextWindow: 272_000, percent: 75.7658 },
			branch: [
				journalInit("init-1"),
				journalDelta("delta-1", "init-1", {
					blocks,
					prunedTools,
					manualMode: false,
					nudgeAnchors: [{ type: "turn" }],
				}),
				compressResult({ tokensSaved: 1_300_000, itemCount: 25, totalSummaryTokens: 5_000 }),
				{ type: "custom", customType: "dcp-nudge", data: { event: "emitted", type: "turn", contextPercent: 75.8, createdAt: 1_700_000_000_000 } },
				{ type: "custom", customType: "dcp-nudge", data: { event: "cleared", clearedAnchors: 1 } },
			],
		});

		const output = formatDcpStatsToast(session as never);
		assert.match(output, /DCP Session Statistics:/);
		assert.match(output, /Tokens saved \(estimated\): 1,303,185/);
		assert.match(output, /Total pruning operations: 62/);
		assert.match(output, /Compression blocks active: 12 \/ 25 total/);
		assert.match(output, /Manual mode: off/);
		assert.match(output, /State source: session journal/);
		assert.match(output, /Sent: 1 emitted, 0 upgraded/);
		assert.match(output, /Active anchors: 1 \(turn=1, iteration=0, context-soft=0, context-strong=0\)/);
		assert.match(output, /Context: 75\.8% \(206\.1K\/272K\)/);
	});

	it("applies later journal block-state/manual/nudge updates without sidecar fallback", () => {
		const session = fakeSession({
			usage: { tokens: 10_000, contextWindow: 40_000, percent: 25 },
			branch: [
				journalInit("init-1"),
				journalDelta("delta-1", "init-1", {
					blocks: [{ id: 1, active: true }, { id: 2, active: true }],
					prunedTools: [{ toolCallId: "tool-a", reason: "manual-sweep", tokenEstimate: 24 }],
					manualMode: false,
				}),
				journalDelta("delta-2", "delta-1", {
					blockStates: [{ id: 1, active: false, deactivatedReason: "superseded" }],
					manualMode: true,
					nudgeAnchors: [{ type: "iteration" }],
					lastNudge: { type: "context-strong", createdAt: 1_700_000_123, contextPercent: 0.4 },
				}),
				compressResult({ tokensSaved: 99 }),
			],
		});

		const output = formatDcpStatsToast(session as never);
		assert.match(output, /Tokens saved \(estimated\): 123/u);
		assert.match(output, /Total pruning operations: 3/u);
		assert.match(output, /Compression blocks active: 1 \/ 2 total/u);
		assert.match(output, /Manual mode: on/u);
		assert.match(output, /State source: session journal/u);
		assert.match(output, /Active anchors: 1 \(turn=0, iteration=1, context-soft=0, context-strong=0\)/u);
		assert.match(output, /Last nudge: context-strong emitted/u);
	});

	it("falls back to successful compress tool results when the session has no journal", () => {
		const session = fakeSession({
			usage: { tokens: 12_000, contextWindow: 100_000, percent: 12 },
			branch: [compressResult({ tokensSaved: 12, activeBlocks: 2, totalBlocks: 4 })],
		});

		const output = formatDcpStatsToast(session as never);
		assert.match(output, /Tokens saved \(estimated\): 12/u);
		assert.match(output, /Compression blocks active: 2 \/ 4 total/u);
		assert.match(output, /Manual mode: unknown/u);
		assert.match(output, /State source: compress tool results/u);
	});

	it("uses the explicit full branch when a lazy tail no longer contains journal init", () => {
		const fullBranch = [
			journalInit("init-1"),
			journalDelta("delta-1", "init-1", {
				blocks: [{ id: 1, active: true }],
				manualMode: true,
			}),
			compressResult({ tokensSaved: 42 }),
		];
		const session = fakeSession({
			usage: { tokens: 1_000, contextWindow: 10_000, percent: 10 },
			// Simulate a lazy tail that starts after the journal init.
			branch: fullBranch.slice(1),
			fullBranch,
		});

		const output = formatDcpStatsToast(session as never);
		assert.match(output, /State source: session journal/u);
		assert.match(output, /Compression blocks active: 1 \/ 1 total/u);
		assert.match(output, /Manual mode: on/u);
	});
});

function fakeSession(options: { usage: unknown; branch: unknown[]; fullBranch?: unknown[] }) {
	return {
		getContextUsage: () => options.usage,
		sessionManager: {
			getBranch: () => options.branch,
			...(options.fullBranch ? { readFullBranchEntriesSync: () => options.fullBranch } : {}),
		},
	};
}

function journalInit(operationId: string) {
	return {
		type: "custom",
		customType: "dcp-journal",
		data: { schemaVersion: 1, kind: "init", operationId, previousOperationId: null, createdAt: 1 },
	};
}

function journalDelta(operationId: string, previousOperationId: string, fields: Record<string, unknown>) {
	return {
		type: "custom",
		customType: "dcp-journal",
		data: { schemaVersion: 1, kind: "delta", operationId, previousOperationId, createdAt: 2, ...fields },
	};
}

function compressResult(details: Record<string, unknown>) {
	return {
		type: "message",
		message: {
			role: "toolResult",
			toolName: "compress",
			content: JSON.stringify(details),
			isError: false,
		},
	};
}
