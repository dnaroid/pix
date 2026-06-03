import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	compactProgressBarSegments,
	contextUsageProgressColor,
	formatCompactProgressBar,
} from "../src/context-progress-bar.js";

describe("compact progress bar", () => {
	it("clamps progress and renders partial cells", () => {
		assert.equal(formatCompactProgressBar(-10, 3), "   ");
		assert.equal(formatCompactProgressBar(0, 3), "   ");
		assert.equal(formatCompactProgressBar(120, 3), "██▉");
		assert.equal(formatCompactProgressBar(100, 3), "██▉");
		const half = formatCompactProgressBar(50, 5);
		assert.equal(half.length, 5);
		assert.equal(half.startsWith("██"), true);
		assert.equal(half.endsWith("  "), true);
		assert.ok("▏▎▍▌▋▊▉".includes(half[2] ?? ""));
		assert.equal(formatCompactProgressBar(25, 0), "");
	});

	it("builds foreground/background segments for active and empty cells", () => {
		assert.deepEqual(compactProgressBarSegments(-1, 50, { fill: "green", track: "gray" }), []);

		const segments = compactProgressBarSegments(4, 50, {
			fill: "green",
			track: "gray",
			emptyForeground: "muted",
		}, 4);

		assert.deepEqual(segments.map(({ start, end }) => [start, end]), [[4, 5], [5, 6], [6, 7], [7, 8]]);
		assert.deepEqual(segments.map((segment) => segment.background), ["gray", "gray", "gray", "gray"]);
		assert.deepEqual(segments.map((segment) => segment.foreground), ["green", "green", "muted", "muted"]);
	});

	it("chooses context usage colors by severity thresholds", () => {
		const colors = { success: "ok", warning: "warn", error: "bad" } as never;

		assert.equal(contextUsageProgressColor(30, colors), "ok");
		assert.equal(contextUsageProgressColor(31, colors), "warn");
		assert.equal(contextUsageProgressColor(50, colors), "warn");
		assert.equal(contextUsageProgressColor(51, colors), "bad");
	});
});
