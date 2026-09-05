import { describe, expect, test } from "bun:test";

import { EVAL_CASES } from "./cases.js";
import { caseAppliesToModel, parseEvalModels, runEvalCase } from "./harness/runner.js";

const RUN_LIVE = /^(1|true|yes)$/i.test(process.env.PI_TOOLS_SUITE_EVALS_LIVE ?? "");
const MODELS = parseEvalModels();
const TIMEOUT_MS = Number(process.env.PI_TOOLS_SUITE_EVAL_TIMEOUT_MS ?? 240_000);
const STREAM_IO = /^(1|true|yes)$/i.test(process.env.PI_TOOLS_SUITE_EVAL_STREAM_IO ?? "");
const KEEP_PROJECT = /^(1|true|yes)$/i.test(process.env.PI_TOOLS_SUITE_EVAL_KEEP ?? "");
const liveTest = RUN_LIVE && MODELS.length > 0 ? test : test.skip;

describe("pi-tools-suite live eval matrix", () => {
	for (const model of MODELS.length > 0 ? MODELS : ["<no-model>"]) {
		for (const evalCase of EVAL_CASES) {
			if (model !== "<no-model>" && !caseAppliesToModel(evalCase, model)) continue;
			liveTest(`${evalCase.id} [${model}]`, async () => {
				const result = await runEvalCase(evalCase, model, { timeoutMs: TIMEOUT_MS, streamIo: STREAM_IO, keepProject: KEEP_PROJECT });
				const failures = result.assertions.filter((assertion) => !assertion.passed);
				expect(failures, failures.map((failure) => `${failure.name}: ${failure.detail ?? ""}`).join("\n")).toEqual([]);
			}, TIMEOUT_MS + 15_000);
		}
	}
});
