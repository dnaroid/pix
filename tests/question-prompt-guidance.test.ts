import assert from "node:assert/strict";
import { test } from "node:test";

import { QUESTION_TOOL_DESCRIPTION as pix } from "../src/bundled-extensions/question/tool-description.js";
import { questionParameters as pixParameters } from "../src/bundled-extensions/question/contract.js";
import { QUESTION_TOOL_DESCRIPTION as cleanPi } from "../external/pi-tools-suite/src/question/tool-description.js";
import { questionParameters as cleanPiParameters } from "../external/pi-tools-suite/src/question/contract.js";

test("question guidance separates context from the form in Pix and clean Pi", () => {
	assert.deepEqual(pix, cleanPi);
	for (const tool of [pix, cleanPi]) {
		const guidance = tool.promptGuidelines.join("\n");
		assert.match(guidance, /context and explanation in the assistant message before calling question/u);
		assert.match(guidance, /without repeating the question or listing its choices there/u);
		assert.match(guidance, /short, self-contained question/u);
		assert.match(guidance, /do not copy the preceding explanation into the form/u);
		assert.match(guidance, /Always include the question prompt, not just choices/u);
	}
});

test("question schemas keep the prompt required and describe it concisely", () => {
	for (const parameters of [pixParameters, cleanPiParameters]) {
		const question = parameters.properties.questions.items;
		assert.ok(question.required?.includes("prompt"));
		const promptSchema = JSON.stringify(question.properties.prompt);
		assert.match(promptSchema, /Short, self-contained question/u);
		assert.match(promptSchema, /background explanation in the preceding assistant message, not here/u);
	}
});
