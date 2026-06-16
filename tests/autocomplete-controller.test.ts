import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { InputEditor } from "../src/input-editor.js";
import { AppAutocompleteController, autocompleteHistoryFromMessages, autocompletePromptTokenEstimate, buildAutocompletePrompt, cleanupCompletion } from "../src/app/input/autocomplete-controller.js";

describe("autocomplete controller helpers", () => {
	it("builds recent active-session history from user and assistant messages", () => {
		const history = autocompleteHistoryFromMessages([
			{ role: "system", content: "ignore" },
			{ role: "user", content: [{ type: "text", text: "first request" }] },
			{ role: "assistant", content: [{ type: "thinking", thinking: "hidden" }, { type: "text", text: "first answer" }] },
			{ role: "toolResult", content: [{ type: "text", text: "tool noise" }] },
			{ role: "user", content: [{ type: "text", text: "latest request\n[note]: # (m123)" }, { type: "image", data: "x", mimeType: "image/png" }] },
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
	it("runs inline autocomplete for eligible drafts and accepts the suggestion", async () => {
		const inputEditor = new InputEditor();
		inputEditor.setText("hello");
		let renders = 0;
		const requests: Array<{ draft: string; configModelRef: string; aborted: boolean }> = [];
		const controller = new AppAutocompleteController(
			{
				runtime: () => ({}) as never,
				inputEditor: () => inputEditor,
				autocompleteConfig: () => ({ modelRef: "provider/model", debounceMs: 0 }),
				isRunning: () => true,
				render: () => {
					renders += 1;
				},
			},
			{
				debounceMs: 0,
				completeInputWithPi: async (_runtime, draft, config, signal) => {
					requests.push({ draft, configModelRef: config.modelRef, aborted: signal.aborted });
					return " world";
				},
			},
		);

		controller.observeInput();
		await new Promise((resolve) => setTimeout(resolve, 5));

		assert.deepEqual(requests, [{ draft: "hello", configModelRef: "provider/model", aborted: false }]);
		assert.equal(controller.suggestionText(), " world");
		assert.equal(controller.acceptSuggestion(), true);
		assert.equal(inputEditor.text, "hello world");
		assert.equal(controller.suggestionText(), undefined);
		assert.ok(renders >= 2);
	});

	it("aborts stale inline completion requests when the draft changes", async () => {
		const inputEditor = new InputEditor();
		const requests: Array<{ draft: string; abortedAtStart: boolean }> = [];
		const controller = new AppAutocompleteController(
			{
				runtime: () => ({}) as never,
				inputEditor: () => inputEditor,
				autocompleteConfig: () => ({ modelRef: "provider/model", debounceMs: 0 }),
				isRunning: () => true,
				render: () => {},
			},
			{
				debounceMs: 0,
				completeInputWithPi: async (_runtime, draft, _config, signal) => {
					requests.push({ draft, abortedAtStart: signal.aborted });
					if (draft === "hello") {
						await new Promise<void>((resolve, reject) => {
							signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
							setTimeout(resolve, 50);
						});
					}
					return draft === "hello" ? " first" : " world";
				},
			},
		);

		inputEditor.setText("hello");
		controller.observeInput();
		await new Promise((resolve) => setTimeout(resolve, 5));
		inputEditor.setText("hello world");
		controller.observeInput();
		await new Promise((resolve) => setTimeout(resolve, 5));

		assert.equal(requests.length, 2);
		assert.equal(requests[0]?.draft, "hello");
		assert.equal(requests[0]?.abortedAtStart, false);
		assert.equal(requests[1]?.draft, "hello world");
		assert.equal(controller.suggestionText(), " world");
	});

	it("skips drafts that are selections, attachments, or shell commands", async () => {
		const inputEditor = new InputEditor();
		const requests: string[] = [];
		const controller = new AppAutocompleteController(
			{
				runtime: () => ({}) as never,
				inputEditor: () => inputEditor,
				autocompleteConfig: () => ({ modelRef: "provider/model", debounceMs: 0 }),
				isRunning: () => true,
				render: () => {},
			},
			{
				debounceMs: 0,
				completeInputWithPi: async (_runtime, draft) => {
					requests.push(draft);
					return "ignored";
				},
			},
		);

		inputEditor.setText("abc");
		(inputEditor as unknown as { _selection: { anchor: number; active: number } })._selection = { anchor: 0, active: 1 };
		controller.observeInput();
		await new Promise((resolve) => setTimeout(resolve, 5));
		assert.equal(requests.length, 0);

		inputEditor.clearSelection();
		(inputEditor as unknown as { _attachments: unknown[] })._attachments.push({ kind: "image", tag: "[Image 1]", image: { type: "image", data: "x", mimeType: "image/png" } });
		controller.observeInput();
		await new Promise((resolve) => setTimeout(resolve, 5));
		assert.equal(requests.length, 0);

		(inputEditor as unknown as { _attachments: unknown[] })._attachments.length = 0;
		inputEditor.setText("/help");
		controller.observeInput();
		await new Promise((resolve) => setTimeout(resolve, 5));
		assert.equal(requests.length, 0);

		inputEditor.setText("!help");
		controller.observeInput();
		await new Promise((resolve) => setTimeout(resolve, 5));
		assert.equal(requests.length, 0);
	});

	it("ignores drafts when the cursor is not at the end", async () => {
		const inputEditor = new InputEditor();
		inputEditor.setText("hello world", 5);
		let called = 0;
		const controller = new AppAutocompleteController(
			{
				runtime: () => ({}) as never,
				inputEditor: () => inputEditor,
				autocompleteConfig: () => ({ modelRef: "provider/model", debounceMs: 0 }),
				isRunning: () => true,
				render: () => {
					called += 1;
				},
			},
			{
				completeInputWithPi: async () => {
					called += 1;
					return "ignored";
				},
			},
		);

		controller.observeInput();
		await new Promise((resolve) => setTimeout(resolve, 5));

		assert.equal(called, 0);
		assert.equal(controller.suggestionText(), undefined);
	});

	it("swallows runner errors and leaves no inline suggestion behind", async () => {
		const inputEditor = new InputEditor();
		inputEditor.setText("hello");
		let renders = 0;
		const controller = new AppAutocompleteController(
			{
				runtime: () => ({}) as never,
				inputEditor: () => inputEditor,
				autocompleteConfig: () => ({ modelRef: "provider/model", debounceMs: 0 }),
				isRunning: () => true,
				render: () => {
					renders += 1;
				},
			},
			{
				completeInputWithPi: async () => {
					throw new Error("boom");
				},
			},
		);

		controller.observeInput();
		await new Promise((resolve) => setTimeout(resolve, 5));

		assert.equal(controller.suggestionText(), undefined);
		assert.equal(renders, 0);
	});

	it("aborts in-flight work on dispose and ignores late completions", async () => {
		const inputEditor = new InputEditor();
		inputEditor.setText("hello world");
		let signal: AbortSignal | undefined;
		let finish!: () => void;
		const finished = new Promise<void>((resolve) => {
			finish = resolve;
		});
		const controller = new AppAutocompleteController(
			{
				runtime: () => ({}) as never,
				inputEditor: () => inputEditor,
				autocompleteConfig: () => ({ modelRef: "provider/model", debounceMs: 0 }),
				isRunning: () => true,
				render: () => {},
			},
			{
				debounceMs: 0,
				completeInputWithPi: async (_runtime, _draft, _config, inSignal) => {
					signal = inSignal;
					await finished;
					return " world";
				},
			},
		);

		controller.observeInput();
		await new Promise((resolve) => setTimeout(resolve, 5));
		controller.dispose();
		assert.equal(signal?.aborted, true);
		finish();
		await new Promise((resolve) => setTimeout(resolve, 5));
		assert.equal(controller.suggestionText(), undefined);
	});

});
