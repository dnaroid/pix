import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { runQuestionnaire } from "../src/bundled-extensions/question/tui.js";
import type { NormalizedQuestion, QuestionComponent, QuestionTheme, QuestionUiContext } from "../src/bundled-extensions/question/types.js";

describe("question TUI", () => {
	it("wraps long choice descriptions instead of truncating them", async () => {
		const questions: NormalizedQuestion[] = [{
			id: "reject",
			label: "Mechanism",
			prompt: "How should early rejection work?",
			choices: [{
				value: "llm-reject",
				label: "LLM verdict",
				description: "The first concept LLM call returns an explicit reject signal, and the UI should keep the full explanation visible across wrapped lines.",
			}],
		}];

		let renderedLines: string[] = [];
		const theme: QuestionTheme = {
			fg: (_color, text) => text,
			bg: (_color, text) => text,
			bold: (text) => text,
			style: (text) => text,
		};
		const ctx: QuestionUiContext = {
			ui: {
				custom<T>(factory: (tui: { requestRender(): void }, theme: QuestionTheme, keybindings: unknown, done: (value: T) => void) => QuestionComponent): Promise<T> {
					const component = factory({ requestRender() {} }, theme, {}, () => {});
					renderedLines = component.render(60);
					return Promise.resolve(null as T);
				},
			},
		};

		await runQuestionnaire(questions, ctx);

		const descriptionLines = renderedLines.filter((line) => line.startsWith("    "));
		assert.ok(descriptionLines.length >= 3);
		assert.ok(descriptionLines.every((line) => !line.includes("…")));
		assert.ok(renderedLines.some((line) => line.includes("full explanation")));
		assert.ok(renderedLines.some((line) => line.includes("visible across wrapped lines.")));
	});
});
