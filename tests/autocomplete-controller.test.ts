import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	autocompleteHistoryFromMessages,
	autocompletePromptTokenEstimate,
	buildAutocompletePrompt,
	cleanupCompletion,
} from "../src/app/input/autocomplete-controller.js";

describe("autocomplete controller helpers", () => {
	it("builds recent active-session history from user and assistant messages", () => {
		const history = autocompleteHistoryFromMessages([
			{ role: "system", content: "ignore" },
			{ role: "user", content: [{ type: "text", text: "first request" }] },
			{ role: "assistant", content: [{ type: "thinking", thinking: "hidden" }, { type: "text", text: "first answer" }] },
			{ role: "toolResult", content: [{ type: "text", text: "tool noise" }] },
			{ role: "user", content: [{ type: "text", text: "latest request\n[dcp-id]: # (m123)" }, { type: "image", data: "x", mimeType: "image/png" }] },
		], 2);

		assert.deepEqual(history, [
			{ role: "assistant", text: "first answer" },
			{ role: "user", text: "latest request\n[image]" },
		]);
	});

	it("puts session history before the current draft in the completion prompt", () => {
		const prompt = buildAutocompletePrompt({
			cwd: "/tmp/project",
			draft: "улучши автокомплит",
			history: [
				{ role: "user", text: "подсказки не в тему" },
				{ role: "assistant", text: "нужно добавить контекст истории" },
			],
		});

		assert.match(prompt, /cwd: \/tmp\/project/u);
		assert.match(prompt, /<message role="user">\nподсказки не в тему\n<\/message>/u);
		assert.match(prompt, /<message role="assistant">\nнужно добавить контекст истории\n<\/message>/u);
		assert.match(prompt, /<draft>\nулучши автокомплит\n<cursor>\n<\/draft>/u);
	});

	it("omits the session history block when history context is disabled", () => {
		const prompt = buildAutocompletePrompt({
			cwd: "/tmp/project",
			draft: "напиши тест",
			history: [],
		});

		assert.doesNotMatch(prompt, /recent-active-session-messages/u);
		assert.match(prompt, /<draft>\nнапиши тест\n<cursor>\n<\/draft>/u);
	});

	it("drops oldest history until the autocomplete prompt fits the token budget", () => {
		const prompt = buildAutocompletePrompt({
			cwd: "/tmp/project",
			draft: "допиши команду",
			history: [
				{ role: "user", text: "старое сообщение ".repeat(80) },
				{ role: "assistant", text: "среднее сообщение" },
				{ role: "user", text: "последний контекст" },
			],
			maxPromptTokens: 256,
		});

		assert.doesNotMatch(prompt, /старое сообщение/u);
		assert.match(prompt, /последний контекст/u);
		assert.ok(autocompletePromptTokenEstimate(prompt) <= 256);
	});

	it("returns an empty prompt when the draft alone exceeds the prompt token budget", () => {
		const prompt = buildAutocompletePrompt({
			cwd: "/tmp/project",
			draft: "очень длинный ввод ".repeat(300),
			history: [{ role: "user", text: "контекст" }],
			maxPromptTokens: 256,
		});

		assert.equal(prompt, "");
	});

	it("cleans repeated drafts, labels, and fenced completions", () => {
		assert.equal(cleanupCompletion("привет мир", "привет", { maxTokens: 8 }), " мир");
		assert.equal(cleanupCompletion("Suffix:  с историей", "", { maxTokens: 8 }), "с историей");
		assert.equal(cleanupCompletion("```text\nготово\n```", "", { maxTokens: 8 }), "готово");
	});
});
