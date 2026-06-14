import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { formatDcpStatsToast } from "../src/app/rendering/dcp-stats.js";

describe("formatDcpStatsToast", () => {
	it("formats detailed DCP session and nudge telemetry for context clicks", () => {
		const sidecar = createSidecarState({
			tokensSaved: 1_303_185,
			totalPruneCount: 62,
			compressionBlocks: Array.from({ length: 25 }, (_, index) => ({ active: index < 12 })),
			prunedToolIds: Array.from({ length: 35 }, (_, index) => `tool-${index}`),
			nudgeAnchors: [{ type: "turn" }],
			manualMode: false,
		});
		const session = fakeSession({
			usage: { tokens: 206_083, contextWindow: 272_000, percent: 75.7658 },
			...sidecar.session,
			branch: [
				{ type: "custom", customType: "dcp-nudge", data: { event: "emitted", type: "turn", contextPercent: 75.8, createdAt: 1_700_000_000_000 } },
				{ type: "custom", customType: "dcp-nudge", data: { event: "upgraded", type: "iteration", contextPercent: 76.1, createdAt: 1_700_000_001_000 } },
				{ type: "custom", customType: "dcp-nudge", data: { event: "cleared", clearedAnchors: 2 } },
			],
		});

		try {
			const output = formatDcpStatsToast(session as never);

			assert.match(output, /DCP Session Statistics:/);
			assert.match(output, /Tokens saved \(estimated\): 1,303,185/);
			assert.match(output, /Total pruning operations: 62/);
			assert.match(output, /Compression blocks active: 12 \/ 25 total/);
			assert.match(output, /Manual mode: off/);
			assert.match(output, /State source: dcp-state sidecar/);
			assert.match(output, /Nudge telemetry:/);
			assert.match(output, /Sent: 1 emitted, 1 upgraded/);
			assert.match(output, /By type: turn=1, iteration=1, context-soft=0, context-strong=0/);
			assert.match(output, /Active anchors: 1 \(turn=1, iteration=0, context-soft=0, context-strong=0\)/);
			assert.match(output, /Cleared after compress: 1 time \(2 anchors\)/);
			assert.match(output, /Compliance proxy: 1 compress-after-nudge \/ 2 nudge events \(50\.0%\)/);
			assert.match(output, /Context: 75\.8% \(206\.1K\/272K\)/);
		} finally {
			sidecar.cleanup();
		}
	});
	it("uses sidecar dcp-state telemetry and ignores older compress tool results", () => {
		const sidecar = createSidecarState({
			tokensSaved: 123,
			totalPruneCount: 7,
			compressionBlocks: [{ active: false }, { active: true }],
			prunedToolIds: ["tool-a"],
			nudgeAnchors: [{ type: "iteration" }],
			lastNudge: { type: "context-strong", createdAt: 1_700_000_123, contextPercent: 0.4 },
		});
		const session = fakeSession({
			usage: { tokens: 10_000, contextWindow: 40_000, percent: 25 },
			...sidecar.session,
			branch: [
				{
					type: "message",
					message: { role: "toolResult", toolName: "compress", content: "tokensSaved: 99\nitemCount: 3", isError: false },
				},
			],
		});

		try {
			const output = formatDcpStatsToast(session as never);

			assert.match(output, /Tokens saved \(estimated\): 123/u);
			assert.match(output, /Total pruning operations: 7/u);
			assert.match(output, /Compression blocks active: 1 \/ 2 total/u);
			assert.match(output, /Active anchors: 1 \(turn=0, iteration=1, context-soft=0, context-strong=0\)/u);
			assert.match(output, /Last nudge: context-strong emitted/u);
			assert.match(output, /40\.0% context/u);
			assert.match(output, /Context: 25% \(10K\/40K\)/u);
		} finally {
			sidecar.cleanup();
		}
	});

	it("prefers the persisted dcp-state sidecar over legacy entries", () => {
		const sessionDir = mkdtempSync(join(tmpdir(), "pi-dcp-stats-"));
		try {
			mkdirSync(join(sessionDir, "dcp-state"));
			writeFileSync(join(sessionDir, "dcp-state", "session_1.json"), JSON.stringify({
				tokensSaved: 456,
				totalPruneCount: 9,
				compressionBlocks: [{ active: true }, { active: true }, { active: false }],
				prunedToolIds: ["tool-a", "tool-b"],
				manualMode: true,
				nudgeAnchors: [{ type: "context-soft" }],
			}));

			const session = fakeSession({
				usage: { tokens: 20_000, contextWindow: 100_000, percent: 20 },
				sessionDir,
				sessionId: "session/1",
				branch: [
					{
						type: "custom",
						customType: "dcp-state",
						data: {
							tokensSaved: 1,
							totalPruneCount: 1,
							compressionBlocks: [{ active: true }],
							manualMode: false,
						},
					},
				],
			});

			const output = formatDcpStatsToast(session as never);

			assert.match(output, /Tokens saved \(estimated\): 456/u);
			assert.match(output, /Total pruning operations: 9/u);
			assert.match(output, /Compression blocks active: 2 \/ 3 total/u);
			assert.match(output, /Manual mode: on/u);
			assert.match(output, /State source: dcp-state sidecar/u);
			assert.match(output, /Active anchors: 1 \(turn=0, iteration=0, context-soft=1, context-strong=0\)/u);
		} finally {
			rmSync(sessionDir, { recursive: true, force: true });
		}
	});

	it("ignores legacy dcp-state entries when no sidecar exists", () => {
		const session = fakeSession({
			usage: { tokens: 12_000, contextWindow: 100_000, percent: 12 },
			branch: [
				{
					type: "custom",
					customType: "dcp-state",
					data: {
						tokensSaved: 999,
						totalPruneCount: 99,
						compressionBlocks: [{ active: true }],
						manualMode: true,
						nudgeAnchors: [{ type: "context-strong" }],
					},
				},
				{
					type: "message",
					message: { role: "toolResult", toolName: "compress", content: "tokensSaved: 12\ntotalPruneCount: 3\nactiveBlocks: 2\ntotalBlocks: 4", isError: false },
				},
			],
		});

		const output = formatDcpStatsToast(session as never);

		assert.match(output, /Tokens saved \(estimated\): 0/u);
		assert.match(output, /Total pruning operations: 0/u);
		assert.match(output, /Compression blocks active: 0 \/ 0 total/u);
		assert.match(output, /Manual mode: unknown/u);
		assert.match(output, /State source: compress tool results/u);
		assert.match(output, /Active anchors: 0/u);
	});

});

function fakeSession(options: { usage: unknown; branch: unknown[]; sessionDir?: string; sessionId?: string }) {
	return {
		getContextUsage: () => options.usage,
		sessionManager: {
			getBranch: () => options.branch,
			getSessionDir: () => options.sessionDir ?? "",
			getSessionId: () => options.sessionId ?? "",
		},
	};
}

function createSidecarState(data: Record<string, unknown>) {
	const sessionDir = mkdtempSync(join(tmpdir(), "pi-dcp-stats-"));
	mkdirSync(join(sessionDir, "dcp-state"));
	writeFileSync(join(sessionDir, "dcp-state", "session_1.json"), JSON.stringify(data));
	return {
		session: { sessionDir, sessionId: "session/1" },
		cleanup: () => rmSync(sessionDir, { recursive: true, force: true }),
	};
}
