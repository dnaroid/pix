import { describe, expect, test } from "bun:test";
import { e2eRetryConfigFromEnv, isRetryableE2ERateLimit, withE2ERetry } from "./e2e-retry.js";

describe("e2e retry helper", () => {
	test("recognizes 429 rate-limit errors", () => {
		expect(isRetryableE2ERateLimit(new Error("429 Rate limit reached for requests"))).toBe(true);
		expect(isRetryableE2ERateLimit(new Error("Rate limit reached for requests"))).toBe(true);
		expect(isRetryableE2ERateLimit(new Error("model exited with 500"))).toBe(false);
	});

	test("retries retryable failures after the configured pause", async () => {
		let attempts = 0;
		const notices: number[] = [];
		const result = await withE2ERetry("rate-limited test", async () => {
			attempts += 1;
			if (attempts === 1) throw new Error("pi exited with 1\nSTDERR:\n429 Rate limit reached for requests");
			return "ok";
		}, { delayMs: 0, maxAttempts: 3, onRetry: ({ attempt }) => notices.push(attempt) });

		expect(result).toBe("ok");
		expect(attempts).toBe(2);
		expect(notices).toEqual([1]);
	});

	test("reads conservative defaults and clamps env overrides", () => {
		expect(e2eRetryConfigFromEnv({}).maxAttempts).toBeGreaterThan(1);
		expect(e2eRetryConfigFromEnv({ PI_TOOLS_SUITE_E2E_RETRY_ATTEMPTS: "0", PI_TOOLS_SUITE_E2E_RETRY_DELAY_MS: "-10" })).toEqual({
			maxAttempts: 1,
			delayMs: 0,
		});
	});
});
