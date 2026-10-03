import { describe, expect, test } from "bun:test";
import { CASES, runCase } from "./runner.js";
import { resolveEvalOutputDir } from "../harness/output-dir.js";

const enabled = process.env.DELIVERY_REVIEW_LIVE === "1";
const outputDir = resolveEvalOutputDir("delivery-review", process.env.DELIVERY_REVIEW_OUTPUT);
describe("delivery-review dedicated live eval", () => {
	for (const scenario of CASES) for (let repetition = 1; repetition <= 3; repetition++) {
		(enabled ? test.concurrent : test.skip)(`${scenario.id} repetition ${repetition}`, async () => {
			const result = await runCase(scenario.id, `${outputDir}/rep-${repetition}`);
			expect(result.status, `${result.artifact}: ${result.issues.join("; ")}`).toBe("passed");
		}, 195_000);
	}
});
