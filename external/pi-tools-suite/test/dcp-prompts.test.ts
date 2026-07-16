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
		expect(SYSTEM_PROMPT).toContain("Low context usage alone does not require compression");
		expect(SYSTEM_PROMPT).toContain("completed implementation, verification");
		expect(SYSTEM_PROMPT).toContain("Do not compress active work");
		expect(SYSTEM_PROMPT).toContain("active objective and next step");
		expect(SYSTEM_PROMPT).toContain("next steps");
		expect(SYSTEM_PROMPT).toContain("Do not infer, invent, or add facts");
		expect(SYSTEM_PROMPT).toContain("Drop incidental transcript detail");
	});

	test("manual mode forbids unsolicited housekeeping but retains summary quality rules", () => {
		expect(MANUAL_MODE_SYSTEM_PROMPT).toContain("do NOT proactively compress");
		expect(MANUAL_MODE_SYSTEM_PROMPT).toContain("Only when the user explicitly asks");
		expect(MANUAL_MODE_SYSTEM_PROMPT).toContain("context-limit emergency");
		expect(MANUAL_MODE_SYSTEM_PROMPT).toContain("Preserve user intent precisely");
		expect(MANUAL_MODE_SYSTEM_PROMPT).toContain("Do not compress active, still-needed context");
	});

	test("strong and soft reminders preserve their distinct urgency boundaries", () => {
		expect(CONTEXT_LIMIT_NUDGE_STRONG).toContain("MUST use the `compress` tool now");
		expect(CONTEXT_LIMIT_NUDGE_STRONG).toContain("one large, closed, high-yield compression range first");
		expect(CONTEXT_LIMIT_NUDGE_STRONG).toContain("preserve user intent exactly");

		expect(CONTEXT_LIMIT_NUDGE_SOFT).toContain("Compress it now if one is safe and useful");
		expect(CONTEXT_LIMIT_NUDGE_SOFT).toContain("If nothing is cleanly closed");
		expect(CONTEXT_LIMIT_NUDGE_SOFT).toContain("continue with the next atomic step");
	});

	test("routine reminders reject low-value compression and protect active context", () => {
		for (const reminder of [TURN_NUDGE, ITERATION_NUDGE]) {
			expect(reminder).toContain("closed");
			expect(reminder).toContain("large");
			expect(reminder).toContain("message-mode compression");
		}
		expect(TURN_NUDGE).toContain("Do not compress just because a small slice closed");
		expect(TURN_NUDGE).toContain("Keep active context uncompressed");
		expect(ITERATION_NUDGE).toContain("If only small or still-needed ranges are closed");
	});

	test("compress tool contract preserves continuation state and safe boundaries", () => {
		expect(COMPRESS_RANGE_DESCRIPTION).toContain("COMPLETE FOR CONTINUATION");
		expect(COMPRESS_RANGE_DESCRIPTION).toContain("Active objective");
		expect(COMPRESS_RANGE_DESCRIPTION).toContain("Next step");
		expect(COMPRESS_RANGE_DESCRIPTION).toContain("exact errors that are still actionable");
		expect(COMPRESS_RANGE_DESCRIPTION).toContain("Do not infer, invent, or add facts");
		expect(COMPRESS_RANGE_DESCRIPTION).toContain("Do not copy long raw code, JSON, diffs, logs");
		expect(COMPRESS_RANGE_DESCRIPTION).toContain("Use `messages` for a single large stale message");
		expect(COMPRESS_RANGE_DESCRIPTION).toContain("Do not invent IDs");
	});
});
