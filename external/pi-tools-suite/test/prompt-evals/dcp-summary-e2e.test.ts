import { describe, expect, test } from "bun:test";
import { generateModelSummary } from "../../src/dcp/auto-compress.js";
import { withE2ERetry } from "../e2e-retry.js";
import { createLiveModelContext, resolveLiveModelRef } from "../support/live-model.js";

const RUN_E2E = /^(1|true|yes)$/i.test(
	process.env.DCP_SUMMARY_E2E ?? process.env.PROMPT_EVAL_E2E ?? "",
);
const E2E_MODEL = resolveLiveModelRef("DCP_SUMMARY_E2E_MODEL");
const E2E_TIMEOUT_MS = Number(process.env.DCP_SUMMARY_E2E_TIMEOUT_MS ?? 180_000);
const e2eTest = RUN_E2E ? test : test.skip;

function textMessage(role: string, text: string, timestamp: number): {
	role: string;
	content: Array<{ type: "text"; text: string }>;
	timestamp: number;
} {
	return { role, content: [{ type: "text", text }], timestamp };
}

describe("DCP direct live summary prompt eval", () => {
	e2eTest("preserves continuation-critical markers and drops repeated log noise", async () => {
		const filler = Array.from({ length: 40 }, () => "DISPOSABLE_LOG_LINE_777 request completed in 12ms").join("\n");
		const result = await withE2ERetry("DCP live summary", async () => {
			const live = await createLiveModelContext(E2E_MODEL);
			return generateModelSummary(
				[E2E_MODEL],
				live.modelRegistry,
				undefined,
				"Checkout retry investigation",
				[
					textMessage("user", "USER_INTENT_RAVEN: fix duplicate checkout charges without changing the public API. CONSTRAINT_NO_SCHEMA_CHANGE: do not alter the database schema.", 1),
					textMessage("assistant", "DECISION_USE_IDEMPOTENCY_KEY: use the existing payment idempotency key. Inspected src/payments.ts and test/payments.test.ts.", 2),
					textMessage("toolResult", filler, 3),
					textMessage("assistant", "ERROR_E409_RETRY_LOOP: focused retry test still fails with E409. Verification: npm test failed only in test/payments.test.ts. NEXT_STEP_PATCH_PAYMENTS_TS: patch src/payments.ts, then rerun the focused test. Preserve the uppercase continuity markers exactly.", 4),
				],
				60_000,
			);
		});

		expect(result.usedModelRef).toBe(E2E_MODEL);
		expect(result.attempts[result.attempts.length - 1]?.outcome).toBe("ok");
		const summary = result.text ?? "";
		for (const marker of [
			"USER_INTENT_RAVEN",
			"CONSTRAINT_NO_SCHEMA_CHANGE",
			"DECISION_USE_IDEMPOTENCY_KEY",
			"ERROR_E409_RETRY_LOOP",
			"NEXT_STEP_PATCH_PAYMENTS_TS",
		]) expect(summary).toContain(marker);
		expect(summary).toContain("src/payments.ts");
		expect(summary).toContain("test/payments.test.ts");
		expect(summary.match(/DISPOSABLE_LOG_LINE_777/g) ?? []).toHaveLength(0);
	}, E2E_TIMEOUT_MS);
});
