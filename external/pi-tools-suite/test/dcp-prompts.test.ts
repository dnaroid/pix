import { describe, expect, test } from "bun:test";
import {
	COMPRESS_RANGE_DESCRIPTION,
	CONTEXT_LIMIT_NUDGE_SOFT,
	CONTEXT_LIMIT_NUDGE_STRONG,
	ITERATION_NUDGE,
	MANUAL_MODE_SYSTEM_PROMPT,
	SYSTEM_PROMPT,
	TURN_NUDGE,
} from "../src/dcp/prompts.js";

describe("DCP prompt contracts", () => {
	test("normal mode ties proactive compression to meaningful pressure and closed work", () => {
		expect(SYSTEM_PROMPT).toMatch(/Low context\s+usage alone does not require compression/);
		expect(SYSTEM_PROMPT).toContain("implementation, verification");
		expect(SYSTEM_PROMPT).toContain("Do not compress active work");
		expect(SYSTEM_PROMPT).toContain("active objective and next step");
		expect(SYSTEM_PROMPT).toContain("next steps");
		expect(SYSTEM_PROMPT).toContain("Do not infer, invent, or add facts");
		expect(SYSTEM_PROMPT).toContain("drop duplicate transcript detail");
	});

	test("manual mode forbids unsolicited housekeeping but retains summary quality rules", () => {
		expect(MANUAL_MODE_SYSTEM_PROMPT).toContain("Do NOT proactively compress");
		expect(MANUAL_MODE_SYSTEM_PROMPT).toContain("user explicitly asks");
		expect(MANUAL_MODE_SYSTEM_PROMPT).toContain("context-limit recovery");
		expect(MANUAL_MODE_SYSTEM_PROMPT).toMatch(/Preserve user\s+intent precisely/);
		expect(MANUAL_MODE_SYSTEM_PROMPT).toContain("Do not compress active, still-needed context");
	});

	test("strong and soft reminders preserve their distinct urgency boundaries", () => {
		expect(CONTEXT_LIMIT_NUDGE_STRONG).toContain("MUST use the `compress` tool now");
		expect(CONTEXT_LIMIT_NUDGE_STRONG).toMatch(/Prefer one\s+large, older, closed high-yield range/);
		expect(CONTEXT_LIMIT_NUDGE_STRONG).toContain("Preserve user intent exactly");

		expect(CONTEXT_LIMIT_NUDGE_SOFT).toContain("compress a high-yield older closed slice if one is safe");
		expect(CONTEXT_LIMIT_NUDGE_SOFT).toContain("If nothing is cleanly closed");
		expect(CONTEXT_LIMIT_NUDGE_SOFT).toMatch(/continue with the next atomic\s+step/);
	});

	test("routine reminders reject low-value compression and protect active context", () => {
		for (const reminder of [TURN_NUDGE, ITERATION_NUDGE]) {
			expect(reminder).toContain("closed");
			expect(reminder).toContain("large");
			expect(reminder).toContain("message-mode compression");
		}
		expect(TURN_NUDGE).toMatch(/Do not compress just because a small\s+slice closed/);
		expect(TURN_NUDGE).toContain("Keep active context uncompressed");
		expect(ITERATION_NUDGE).toContain("If only small or still-needed ranges are closed");
	});

	test("compress tool contract preserves continuation state and safe boundaries", () => {
		expect(COMPRESS_RANGE_DESCRIPTION).toContain("COMPLETE FOR CONTINUATION");
		expect(COMPRESS_RANGE_DESCRIPTION).toContain("Active objective");
		expect(COMPRESS_RANGE_DESCRIPTION).toMatch(/`Next\s+step`/);
		expect(COMPRESS_RANGE_DESCRIPTION).toMatch(/exact\s+errors that are still actionable/);
		expect(COMPRESS_RANGE_DESCRIPTION).toContain("Do not infer, invent, or add facts");
		expect(COMPRESS_RANGE_DESCRIPTION).toMatch(/Do not copy long\s+raw code, JSON, diffs, logs/);
		expect(COMPRESS_RANGE_DESCRIPTION).toMatch(/Use\s+`messages` for a single large stale message/);
		expect(COMPRESS_RANGE_DESCRIPTION).toContain("Do not invent IDs");
		expect(COMPRESS_RANGE_DESCRIPTION).toMatch(/For\s+`ranges`, never split a tool group/);
		expect(COMPRESS_RANGE_DESCRIPTION).toMatch(/the calling assistant and all its\s+tool results, including parallel calls/);
		expect(COMPRESS_RANGE_DESCRIPTION).toContain("stable user/tool-result");
		expect(COMPRESS_RANGE_DESCRIPTION).toContain("IDs may be sparse");
	});

	test("rollup guidance does not require recursive summaries or mistake a partial commit for relief", () => {
		expect(COMPRESS_RANGE_DESCRIPTION).toMatch(/Placeholders are\s+optional/);
		expect(COMPRESS_RANGE_DESCRIPTION).toContain("summarize their continuation-relevant");
		expect(COMPRESS_RANGE_DESCRIPTION).not.toContain("Include every required block placeholder exactly once");
		expect(COMPRESS_RANGE_DESCRIPTION).toContain("non-positive full-projection gain");
		expect(COMPRESS_RANGE_DESCRIPTION).toContain("remainingRecoveryTokens");
		expect(COMPRESS_RANGE_DESCRIPTION).toContain("An unsuccessful call");
		expect(COMPRESS_RANGE_DESCRIPTION).toContain("does not satisfy a reminder");
	});
});
