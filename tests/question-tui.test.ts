import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { runQuestionnaire } from "../src/bundled-extensions/question/tui.js";
import type { NormalizedQuestion, QuestionComponent, QuestionTheme, QuestionUiContext } from "../src/bundled-extensions/question/types.js";

describe("question TUI", () => {
	it("collects predefined and custom answers additively for multi-select questions", async () => {
		const questions: NormalizedQuestion[] = [{
			id: "areas",
			label: "Areas",
			prompt: "Which areas?",
			choices: [{ value: "api", label: "API" }, { value: "ui", label: "UI" }],
			multiple: true,
			minSelections: 2,
			maxSelections: 2,
		}];
		const theme: QuestionTheme = {
			fg: (_color, text) => text,
			bg: (_color, text) => text,
			bold: (text) => text,
			style: (text) => text,
		};
		const ctx: QuestionUiContext = {
			ui: {
				custom<T>(factory: (tui: { requestRender(): void }, theme: QuestionTheme, keybindings: unknown, done: (value: T) => void) => QuestionComponent): Promise<T> {
					return new Promise<T>((resolve) => {
						const component = factory({ requestRender() {} }, theme, {}, resolve);
						const clickCustom = (): void => {
							const lines = component.render(80);
							const row = lines.findIndex((line) => line.includes("Something else…"));
							const column = lines[row]?.indexOf("Something else…") ?? -1;
							assert.ok(row >= 0 && column >= 0);
							component.handleMouse?.({ button: 0, x: column, y: row, released: true, localRow: row, localColumn: column, width: 80 });
						};
						component.handleInput("1");
						clickCustom();
						component.handleInput("Documentation");
						clickCustom();
						assert.ok(component.render(80).some((line) => line.includes("[ ] Something else…")));
						clickCustom();
						component.handleInput("\n");
						component.handleInput("2");
						const lines = component.render(80);
						assert.ok(lines.some((line) => line.includes("[x] API")));
						assert.ok(lines.some((line) => line.includes("[ ] UI")));
						assert.ok(lines.some((line) => line.includes("[x] Something else…")));
						component.handleInput("\t");
						component.handleInput("\n");
					});
				},
			},
		};

		assert.deepEqual(await runQuestionnaire(questions, ctx), [{
			id: "areas",
			choiceValues: ["api"],
			customText: "Documentation",
		}]);
	});

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
