import { describe, expect, test } from "bun:test";

describe("DCP headless helpers", () => {
	test("normalizes Pi context usage for tool responses and pruning decisions", async () => {
		const { normalizeDcpContextUsage } = await import("../src/dcp/ui.js");

		expect(normalizeDcpContextUsage({ tokens: 42_000, contextWindow: 100_000 })).toEqual({
			tokens: 42_000,
			contextWindow: 100_000,
		});
		expect(normalizeDcpContextUsage({ tokens: 42_000, contextWindow: 100_000, percent: 6.6 })).toEqual({
			tokens: 6_600,
			contextWindow: 100_000,
			percent: 6.6,
		});
		expect(normalizeDcpContextUsage({ contextWindow: 100_000, percent: null })).toEqual({
			tokens: null,
			contextWindow: 100_000,
			percent: null,
		});
		expect(normalizeDcpContextUsage(undefined)).toBeUndefined();
		expect(normalizeDcpContextUsage({ tokens: 1, contextWindow: 0 })).toBeUndefined();
	});
});
