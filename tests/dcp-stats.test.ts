import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { formatDcpStatsToast } from "../src/app/screen/dcp-stats-toast.js";

describe("formatDcpStatsToast", () => {
	it("formats detailed DCP session and nudge telemetry for context clicks", () => {
		const session = fakeSession({
			usage: { tokens: 206_083, contextWindow: 272_000, percent: 75.7658 },
			branch: [
				{
					type: "custom",
					customType: "dcp-state",
					data: {
						tokensSaved: 1_303_185,
						totalPruneCount: 62,
						compressionBlocks: Array.from({ length: 25 }, (_, index) => ({ active: index < 12 })),
						prunedToolIds: Array.from({ length: 35 }, (_, index) => `tool-${index}`),
						nudgeAnchors: [{ type: "turn" }],
					},
				},
				{ type: "custom", customType: "dcp-nudge", data: { event: "emitted", type: "turn", contextPercent: 75.8, createdAt: 1_700_000_000_000 } },
				{ type: "custom", customType: "dcp-nudge", data: { event: "upgraded", type: "iteration", contextPercent: 76.1, createdAt: 1_700_000_001_000 } },
				{ type: "custom", customType: "dcp-nudge", data: { event: "cleared", clearedAnchors: 2 } },
			],
		});

		const output = formatDcpStatsToast(session as never);

		assert.match(output, /DCP Session Statistics:/);
		assert.match(output, /Tokens saved \(estimated\): 1,303,185/);
		assert.match(output, /Total pruning operations: 62/);
		assert.match(output, /Compression blocks active: 12 \/ 25 total/);
		assert.match(output, /Nudge telemetry:/);
		assert.match(output, /Sent: 1 emitted, 1 upgraded/);
		assert.match(output, /By type: turn=1, iteration=1, context-soft=0, context-strong=0/);
		assert.match(output, /Active anchors: 1 \(turn=1, iteration=0, context-soft=0, context-strong=0\)/);
		assert.match(output, /Cleared after compress: 1 time \(2 anchors\)/);
		assert.match(output, /Compliance proxy: 1 compress-after-nudge \/ 2 nudge events \(50\.0%\)/);
		assert.match(output, /Context: 75\.8% \(206\.1K\/272K\)/);
	});
	it("uses latest dcp-state telemetry and ignores older compress tool results", () => {
		const session = fakeSession({
			usage: { tokens: 10_000, contextWindow: 40_000, percent: 25 },
			branch: [
				{
					type: "message",
					message: { role: "toolResult", toolName: "compress", content: "tokensSaved: 99\nitemCount: 3", isError: false },
				},
				{
					type: "custom",
					customType: "dcp-state",
					data: {
						tokensSaved: 123,
						totalPruneCount: 7,
						compressionBlocks: [{ active: false }, { active: true }],
						prunedToolIds: ["tool-a"],
						nudgeAnchors: [{ type: "iteration" }],
						lastNudge: { type: "context-strong", createdAt: 1_700_000_123, contextPercent: 0.4 },
					},
				},
			],
		});

		const output = formatDcpStatsToast(session as never);

		assert.match(output, /Tokens saved \(estimated\): 123/u);
		assert.match(output, /Total pruning operations: 7/u);
		assert.match(output, /Compression blocks active: 1 \/ 2 total/u);
		assert.match(output, /Active anchors: 1 \(turn=0, iteration=1, context-soft=0, context-strong=0\)/u);
		assert.match(output, /Last nudge: context-strong emitted/u);
		assert.match(output, /40\.0% context/u);
		assert.match(output, /Context: 25% \(10K\/40K\)/u);
	});

});

function fakeSession(options: { usage: unknown; branch: unknown[] }) {
	return {
		getContextUsage: () => options.usage,
		sessionManager: { getBranch: () => options.branch },
	};
}
