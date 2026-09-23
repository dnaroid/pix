import { describe, expect, test } from "bun:test";
import { CASES, runCase } from "./runner.js";

const enabled = process.env.DELIVERY_REVIEW_LIVE === "1";
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const outputDir = process.env.DELIVERY_REVIEW_OUTPUT ?? `test/evals/artifacts/delivery-review-${stamp}`;
describe("delivery-review dedicated live eval", () => {
	for (const scenario of CASES) for (let repetition = 1; repetition <= 3; repetition++) {
		(enabled ? test.concurrent : test.skip)(`${scenario.id} repetition ${repetition}`, async () => {
			const result = await runCase(scenario.id, `${outputDir}/rep-${repetition}`);
			expect(result.status, `${result.artifact}: ${result.issues.join("; ")}`).toBe("passed");
		}, 195_000);
	}
});
