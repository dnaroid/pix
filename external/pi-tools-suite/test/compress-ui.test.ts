import { describe, expect, test } from "bun:test";

const DCP_GREEN = "\x1b[38;2;21;128;61m";
const DCP_YELLOW = "\x1b[38;2;161;98;7m";
const DCP_RED = "\x1b[38;2;185;28;28m";
const DCP_TEAL = "\x1b[38;2;15;118;110m";
const DCP_GRAY = "\x1b[38;2;55;65;81m";

function stripAnsi(text: string | undefined): string {
	return (text ?? "").replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
}

describe("DCP UI", () => {
	test("renders compact DCP status and compression text", async () => {
		const { createState } = await import("../src/compress/state.js");
		const {
			__formatDcpCompressionMessageTextForTest,
			__renderDcpStatusLabelForTest,
		} = await import("../src/compress/ui.js");

		const theme = {
			fg: (_color: string, text: string) => text,
			bg: (_color: string, text: string) => text,
			bold: (text: string) => text,
		} as any;

		const state = createState();
		state.tokensSaved = 125_000;
		state.prunedToolIds.add("tool-1");
		state.compressionBlocks.push({
			id: 2,
			topic: "QA Stop Removal",
			summary: "Compressed implementation details.",
			startTimestamp: 10,
			endTimestamp: 20,
			anchorTimestamp: 21,
			active: true,
			summaryTokenEstimate: 1792,
			createdAt: Date.now(),
			coveredBlockIds: [],
			mode: "range",
		});

		const status = __renderDcpStatusLabelForTest(state, theme, { tokens: 658_000, contextWindow: 1_300_000 });
		expect(status).toContain("DCP");
		expect(status).not.toContain("✂");
		expect(status).toContain("658.0K/1.3M");
		expect(status).toContain("█");
		expect(status).toContain("░");
		expect(status).toContain("-125.0K");
		expect(status).not.toContain("█████████████");

		const compressionDetails = {
			topic: "QA Stop Removal",
			blockIds: [2],
			ranges: 1,
			messages: 0,
			itemCount: 1,
			totalSummaryTokens: 1792,
			activeBlocks: 1,
			totalBlocks: 1,
			prunedTools: 1,
			tokensSaved: 125_000,
			contextTokens: 658_000,
			contextWindow: 1_300_000,
		};

		const chat = __formatDcpCompressionMessageTextForTest(compressionDetails, theme, false);
		expect(chat.split("\n")).toHaveLength(1);
		expect(chat).toContain("compressed");
		expect(chat).toContain("saved 125.0K");
		expect(chat).toContain("658.0K/1.3M");
		expect(chat).toContain("QA Stop Removal");
		expect(chat).not.toContain("u/f/e");
		expect(__formatDcpCompressionMessageTextForTest(compressionDetails, undefined, false)).toContain(DCP_TEAL);

		const longTopicChat = __formatDcpCompressionMessageTextForTest({
			...compressionDetails,
			topic: "1234567890123456789012345678901234567890",
		}, theme, false);
		expect(longTopicChat).toContain("12345678901234567890123456789012345…");

		const percentChat = __formatDcpCompressionMessageTextForTest({
			...compressionDetails,
			contextTokens: 74_900,
			contextPercent: 6.6,
		}, theme, false);
		expect(percentChat).toContain("6.6%/1.3M");
		expect(percentChat).not.toContain("74.9K/1.3M");
	});

	test("DCP UI controller does not write footer status or top widget", async () => {
		const { createState } = await import("../src/compress/state.js");
		const { DcpUiController } = await import("../src/compress/ui.js");
		const state = createState();
		state.tokensSaved = 161_500;

		const ui = {
			theme: {
				fg: (_color: string, text: string) => text,
				bg: (_color: string, text: string) => text,
				bold: (text: string) => text,
			},
			statuses: new Map<string, string | undefined>(),
			widgets: [] as unknown[],
			setStatus(key: string, value: string | undefined) { this.statuses.set(key, value); },
			setWidget(...args: unknown[]) { this.widgets.push(args); },
		} as any;

		const controller = new DcpUiController(state);
		controller.setUICtx(ui);
		controller.update({ getContextUsage: () => ({ tokens: 39_400, contextWindow: 272_000 }) } as any);

		expect(ui.statuses.get("dcp")).toBeUndefined();
		expect(ui.widgets).toEqual([]);
	});

	test("DCP UI controller does not render active nudge telemetry", async () => {
		const { createState } = await import("../src/compress/state.js");
		const { DcpUiController } = await import("../src/compress/ui.js");
		const state = createState();
		state.nudgeAnchors.push({
			id: 1,
			type: "iteration",
			anchorTimestamp: 10,
			anchorRole: "user",
			turnIndex: 2,
			contextPercent: 0.52,
			createdAt: Date.now(),
			updatedAt: Date.now(),
		});
		state.lastNudge = {
			type: "iteration",
			anchorId: 1,
			anchorTimestamp: 10,
			createdAt: Date.now(),
		};

		const ui = {
			theme: {
				fg: (_color: string, text: string) => text,
				bg: (_color: string, text: string) => text,
				bold: (text: string) => text,
			},
			statuses: new Map<string, string | undefined>(),
			setStatus(key: string, value: string | undefined) { this.statuses.set(key, value); },
		} as any;

		const controller = new DcpUiController(state);
		controller.setUICtx(ui);
		controller.update({ getContextUsage: () => ({ tokens: 39_400, contextWindow: 272_000, percent: 14.5 }) } as any);

		expect(ui.statuses.get("dcp")).toBeUndefined();
	});

	test("DCP UI controller ignores stale session contexts during session replacement", async () => {
		const { createState } = await import("../src/compress/state.js");
		const { DcpUiController } = await import("../src/compress/ui.js");
		const state = createState();

		const ui = {
			theme: {
				fg: (_color: string, text: string) => text,
				bg: (_color: string, text: string) => text,
				bold: (text: string) => text,
			},
			statuses: new Map<string, string | undefined>(),
			setStatus(key: string, value: string | undefined) { this.statuses.set(key, value); },
		} as any;

		const controller = new DcpUiController(state);
		controller.setUICtx(ui);

		expect(() => controller.update({
			getContextUsage: () => {
				throw new Error("This extension ctx is stale after session replacement or reload.");
			},
		} as any)).not.toThrow();

		expect(ui.statuses.get("dcp")).toBeUndefined();
	});

	test("footer context bar ignores cumulative saved tokens", async () => {
		const { createState } = await import("../src/compress/state.js");
		const { __renderDcpStatusLabelForTest } = await import("../src/compress/ui.js");
		const theme = {
			fg: (_color: string, text: string) => text,
			bg: (_color: string, text: string) => text,
			bold: (text: string) => text,
		} as any;
		const state = createState();
		state.tokensSaved = 206_900;

		const status = __renderDcpStatusLabelForTest(state, theme, { tokens: 45_400, contextWindow: 272_000 });

		expect(status).toContain("45.4K/272.0K");
		expect(stripAnsi(status)).toContain("██░░░░░░░░░░░░");
		expect(status).toContain("-206.9K saved");
		expect(status).not.toContain("████████████");
		expect(status).toContain(DCP_GREEN);
		expect(status).not.toContain(DCP_TEAL);
		expect(status).toContain(DCP_GRAY);
	});

	test("footer context bar omits session-level cleaned context cells", async () => {
		const { createState } = await import("../src/compress/state.js");
		const { __renderDcpStatusLabelForTest } = await import("../src/compress/ui.js");
		const state = createState();
		state.tokensSaved = 24_200;

		const status = __renderDcpStatusLabelForTest(state, undefined, { tokens: 56_100, contextWindow: 272_000 });

		expect(status).toContain(DCP_GREEN);
		expect(status).not.toContain(DCP_TEAL);
		expect(status).toContain(`${DCP_GRAY}░`);
		expect(stripAnsi(status)).toContain("███░░░░░░░░░░░");
	});

	test("footer context bar colors occupied context by usage threshold", async () => {
		const { createState } = await import("../src/compress/state.js");
		const { __renderDcpStatusLabelForTest } = await import("../src/compress/ui.js");
		const state = createState();
		const theme = {
			fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
			bg: (_color: string, text: string) => text,
			bold: (text: string) => text,
		} as any;

		expect(__renderDcpStatusLabelForTest(state, theme, { tokens: 30, contextWindow: 100 })).toContain(DCP_GREEN)
		expect(__renderDcpStatusLabelForTest(state, theme, { tokens: 50, contextWindow: 100 })).toContain(DCP_YELLOW)
		expect(__renderDcpStatusLabelForTest(state, theme, { tokens: 51, contextWindow: 100 })).toContain(DCP_RED)
	});

	test("footer context bar uses Pi context percent as source of truth", async () => {
		const { createState } = await import("../src/compress/state.js");
		const { __renderDcpStatusLabelForTest } = await import("../src/compress/ui.js");
		const state = createState();

		const status = __renderDcpStatusLabelForTest(state, undefined, { tokens: 74_900, contextWindow: 272_000, percent: 6.6 });

		expect(status).toContain("18.0K/272.0K");
		expect(stripAnsi(status)).toContain("█░░░░░░░░░░░░░");
	});

});
