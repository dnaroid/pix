import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { runQuestionnaire } from "../src/bundled-extensions/question/tui.js";
import type { NormalizedQuestion, QuestionComponent, QuestionTheme, QuestionUiContext } from "../src/bundled-extensions/question/types.js";

describe("question TUI", () => {
	it("uses Space to toggle multi-select choices and Enter to advance and submit", async () => {
		const questions: NormalizedQuestion[] = [
			{
				id: "areas",
				label: "Areas",
				prompt: "Which areas?",
				choices: [{ value: "api", label: "API" }, { value: "ui", label: "UI" }],
				multiple: true,
				minSelections: 1,
				maxSelections: 2,
			},
			{
				id: "targets",
				label: "Targets",
				prompt: "Which targets?",
				choices: [{ value: "cli", label: "CLI" }, { value: "desktop", label: "Desktop" }],
				multiple: true,
				minSelections: 1,
				maxSelections: 2,
			},
		];
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
						component.handleInput(" ");
						assert.ok(component.render(80).some((line) => line.includes("[x] API")));

						component.handleInput("\n");
						assert.ok(component.render(80).some((line) => line.includes("2/2 Targets")));

						component.handleInput(" ");
						assert.ok(component.render(80).some((line) => line.includes("[x] CLI")));
						component.handleInput("\n");
					});
				},
			},
		};

		assert.deepEqual(await runQuestionnaire(questions, ctx), [
			{ id: "areas", choiceValues: ["api"] },
			{ id: "targets", choiceValues: ["cli"] },
		]);
	});

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
						component.handleInput(" ");
						component.handleInput("\u001b[B");
						component.handleInput("\u001b[B");
						component.handleInput(" ");
						component.handleInput("Documentation");
						component.handleInput("\u001b");
						assert.ok(component.render(80).some((line) => line.includes("[x] Something else…")));
						component.handleInput("\u001b[B");
						component.handleInput("\u001b[B");
						component.handleInput(" ");
						assert.ok(component.render(80).some((line) => line.includes("[ ] Something else…")));
						component.handleInput(" ");
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
