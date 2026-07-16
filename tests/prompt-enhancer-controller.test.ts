import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { APP_ICONS } from "../src/app/icons.js";
import {
	AppPromptEnhancerController,
	promptEnhancerTextIsSufficient,
	setPromptEnhancerPiTestDeps,
	type AppPromptEnhancerControllerHost,
} from "../src/app/input/prompt-enhancer-controller.js";
import { InputEditor } from "../src/input-editor.js";

describe("AppPromptEnhancerController", () => {
	it("enables the widget only when there is enough text or work is running", () => {
		const editor = new InputEditor();
		const controller = new AppPromptEnhancerController(createHost(editor, emptyMessages()));

		editor.setText("  ");
		assert.equal(controller.statusWidgetText(), APP_ICONS.autoFix);
		assert.equal(controller.statusWidgetActive(), false);
		assert.equal(controller.statusWidgetEnabled(), false);
		assert.equal(promptEnhancerTextIsSufficient("ab"), false);
		assert.equal(promptEnhancerTextIsSufficient("abc"), true);

		editor.setText("abc");
		assert.equal(controller.statusWidgetEnabled(), true);
	});

	it("shows only the hourglass while enhancement is running", () => {
		const controller = new AppPromptEnhancerController({} as AppPromptEnhancerControllerHost);
		(controller as unknown as { enhancing: boolean }).enhancing = true;

		assert.equal(controller.statusWidgetText(), APP_ICONS.timerSand);
		assert.ok(!controller.statusWidgetText().includes(APP_ICONS.autoFix));
		assert.equal(controller.statusWidgetActive(), true);
		assert.equal(controller.statusWidgetEnabled(), true);
	});

	it("reports unavailable runtime, too-short input, duplicate runs, stale input, and runner errors", async () => {
		const editor = new InputEditor();
		const messages = emptyMessages();
		let runtimeEnabled = false;
		const controller = new AppPromptEnhancerController(createHost(editor, {
			...messages,
			runtime: () => runtimeEnabled ? ({ cwd: "/tmp", session: { isStreaming: false, isCompacting: true } }) as unknown as ReturnType<AppPromptEnhancerControllerHost["runtime"]> : undefined,
		}), { enhancePromptWithPi: async () => "unused" });

		await controller.enhancePrompt();
		assert.deepEqual(messages.errors, ["Prompt enhancer unavailable: runtime is not initialized"]);

		runtimeEnabled = true;
		editor.setText("no");
		await controller.enhancePrompt();
		assert.deepEqual(messages.warnings, ["Type at least 3 characters to enhance"]);

		(controller as unknown as { enhancing: boolean }).enhancing = true;
		await controller.enhancePrompt();
		assert.equal(messages.warnings[messages.warnings.length - 1], "Prompt enhancement is already running");
		(controller as unknown as { enhancing: boolean }).enhancing = false;

		editor.setText("draft prompt");
		const staleController = new AppPromptEnhancerController(createHost(editor, {
			...emptyMessages(),
			warnings: messages.warnings,
			inputStateForTab: () => ({ text: "changed elsewhere", cursor: 0 }),
		}), { enhancePromptWithPi: async () => "enhanced" });
		await staleController.enhancePrompt();
		assert.equal(messages.warnings[messages.warnings.length - 1], "Prompt was changed before enhancement completed; result was not applied");

		const errorController = new AppPromptEnhancerController(createHost(editor, messages), { enhancePromptWithPi: async () => { throw new Error("boom"); } });
		await errorController.enhancePrompt();
		assert.match(messages.errors[messages.errors.length - 1] ?? "", /Prompt enhance failed: boom/u);
	});

	it("enhances only the selected range and restores the previous streaming state", async () => {
		const editor = new InputEditor();
		editor.setText("keep weak draft keep", 15);
		(editor as unknown as { _selection: { anchor: number; active: number } })._selection = { anchor: 5, active: 15 };
		const messages = emptyMessages();
		const statuses: unknown[] = [];
		const activities: string[] = [];
		const controller = new AppPromptEnhancerController(createHost(editor, {
			...messages,
			setSessionStatus: (session) => statuses.push(session),
			setSessionActivity: (activity) => activities.push(activity),
		}), {
			enhancePromptWithPi: async (_runtime, draft) => {
				assert.equal(draft, "weak draft");
				return "strong prompt";
			},
		});

		await controller.enhancePrompt();

		assert.equal(editor.text, "keep strong prompt keep");
		assert.equal(editor.cursor, "keep strong prompt".length);
		assert.deepEqual(messages.successes, ["Selection enhanced"]);
		assert.equal(activities[0], "thinking");
		assert.equal(activities[activities.length - 1], "idle");
		assert.equal(statuses.length, 1);
	});

	it("enhances the whole draft when a whitespace selection is present", async () => {
		const editor = new InputEditor();
		editor.setText("improve this prompt");
		(editor as unknown as { _selection: { anchor: number; active: number } })._selection = { anchor: 0, active: 3 };
		const messages = emptyMessages();
		let draftSeen: string | undefined;
		const controller = new AppPromptEnhancerController(createHost(editor, messages), {
			enhancePromptWithPi: async (_runtime, draft) => {
				draftSeen = draft;
				return "better prompt";
			},
		});

		(editor as unknown as { _text: string; _selection: { anchor: number; active: number } })._text = "   improve this prompt";
		(editor as unknown as { _cursor: number })._cursor = "   improve this prompt".length;
		(editor as unknown as { _selection: { anchor: number; active: number } })._selection = { anchor: 0, active: 3 };

		await controller.enhancePrompt();

		assert.equal(draftSeen, "   improve this prompt");
		assert.equal(editor.text, "better prompt");
		assert.deepEqual(messages.successes, ["Prompt enhanced"]);
	});

	it("applies the enhanced prompt to the invoking tab when completion happens after a tab switch", async () => {
		const editor = new InputEditor();
		editor.setText("improve this original tab draft");
		const warnings: string[] = [];
		const successes: string[] = [];
		const enhancement = deferred<string>();
		let enhancedDraft: string | undefined;
		let activeTabId: string | undefined = "tab-1";
		const inputStatesByTabId = new Map<string, { text: string; cursor: number }>();

		const controller = new AppPromptEnhancerController(createHost(editor, {
			warnings,
			successes,
			activeInputTabId: () => activeTabId,
			inputStateForTab: (tabId) => tabId === activeTabId
				? { text: editor.text, cursor: editor.cursor }
				: inputStatesByTabId.get(tabId ?? ""),
			setInputStateForTab: (tabId, state) => {
				if (tabId === activeTabId) editor.setText(state.text, state.cursor);
				else inputStatesByTabId.set(tabId ?? "", state);
			},
		}), {
			enhancePromptWithPi: async (_runtime, draft) => {
				enhancedDraft = draft;
				return await enhancement.promise;
			},
		});

		const running = controller.enhancePrompt();
		await Promise.resolve();

		assert.equal(enhancedDraft, "improve this original tab draft");

		// Simulates AppTabsController restoring another tab's input into the shared editor
		// while enhancement is still running.
		inputStatesByTabId.set("tab-1", { text: "improve this original tab draft", cursor: editor.cursor });
		activeTabId = "tab-2";
		editor.setText("current active tab draft");
		enhancement.resolve("enhanced result");
		await running;

		assert.equal(editor.text, "current active tab draft");
		assert.deepEqual(inputStatesByTabId.get("tab-1"), { text: "enhanced result", cursor: "enhanced result".length });
		assert.deepEqual(warnings, []);
		assert.deepEqual(successes, ["Prompt enhanced"]);
	});

	it("enhances through mocked Pi services without starting a real SDK session", async () => {
		const editor = new InputEditor();
		editor.setText("make this clearer");
		const messages = emptyMessages();
		const prompts: string[] = [];
		const disposed: boolean[] = [];
		let unsubscribeCalled = false;

		setPromptEnhancerPiTestDeps({
			createAgentSessionServices: async () => fakeServices([{ provider: "test", id: "model", name: "Test Model" }]),
			createAgentSessionFromServices: async () => ({
				session: {
					subscribe: (listener: (event: unknown) => void) => {
						listener(textDelta("```text\nImproved prompt\n```"));
						return () => { unsubscribeCalled = true; };
					},
					prompt: async (prompt: string) => { prompts.push(prompt); },
					dispose: () => { disposed.push(true); },
				},
			}) as never,
			sessionManagerInMemory: () => ({ kind: "memory" }) as never,
		});
		try {
			const controller = new AppPromptEnhancerController(createHost(editor, messages));

			await controller.enhancePrompt();

			assert.equal(editor.text, "Improved prompt");
			assert.match(prompts[0] ?? "", /<draft>\nmake this clearer\n<\/draft>/u);
			assert.equal(unsubscribeCalled, true);
			assert.deepEqual(disposed, [true]);
			assert.deepEqual(messages.successes, ["Prompt enhanced"]);
		} finally {
			setPromptEnhancerPiTestDeps();
		}
	});

	it("reports mocked Pi enhancer model, stream, and empty-output failures", async () => {
		const editor = new InputEditor();
		editor.setText("make this clearer");
		const errors: string[] = [];
		const baseMessages = { ...emptyMessages(), errors };

		setPromptEnhancerPiTestDeps({
			createAgentSessionServices: async () => fakeServices([
				{ provider: "test", id: "other", name: "Test Other" },
				{ provider: "near", id: "model", name: "Near Model" },
			]),
		});
		try {
			await new AppPromptEnhancerController(createHost(editor, baseMessages)).enhancePrompt();
			const modelError = errors.pop() ?? "";
			assert.match(modelError, /Model not found: test\/model/u);
			assert.match(modelError, /near\/model/u);
			assert.match(modelError, /test\/other/u);
		} finally {
			setPromptEnhancerPiTestDeps();
		}

		for (const scenario of [
			{ event: errorDelta("stream exploded"), expected: /stream exploded/u },
			{ event: textDelta("   "), expected: /model returned an empty prompt/u },
		]) {
			setPromptEnhancerPiTestDeps({
				createAgentSessionServices: async () => fakeServices([{ provider: "test", id: "model" }]),
				createAgentSessionFromServices: async () => ({
					session: {
						subscribe: (listener: (event: unknown) => void) => {
							listener(scenario.event);
							return () => {};
						},
						prompt: async () => {},
						dispose: () => {},
					},
				}) as never,
				sessionManagerInMemory: () => ({}) as never,
			});
			try {
				await new AppPromptEnhancerController(createHost(editor, baseMessages)).enhancePrompt();
				assert.match(errors.pop() ?? "", scenario.expected);
			} finally {
				setPromptEnhancerPiTestDeps();
			}
		}
	});
});

function createHost(
	editor: InputEditor,
	messages: {
		warnings: string[];
		successes: string[];
		errors?: string[];
		runtime?: () => ReturnType<AppPromptEnhancerControllerHost["runtime"]>;
		activeInputTabId?: () => string | undefined;
		inputStateForTab?: (tabId: string | undefined) => { text: string; cursor: number } | undefined;
		setInputStateForTab?: (tabId: string | undefined, state: { text: string; cursor: number }) => void;
		setSessionStatus?: AppPromptEnhancerControllerHost["setSessionStatus"];
		setSessionActivity?: AppPromptEnhancerControllerHost["setSessionActivity"];
	},
): AppPromptEnhancerControllerHost {
	const session = { isStreaming: false, isCompacting: false };
	return {
		runtime: () => messages.runtime ? messages.runtime() : ({
			cwd: "/tmp",
			session,
			services: {
				agentDir: "/tmp/.pi",
				settingsManager: {},
				modelRuntime: {},
			},
		}) as unknown as ReturnType<AppPromptEnhancerControllerHost["runtime"]>,
		inputEditor: () => editor,
		activeInputTabId: () => messages.activeInputTabId?.(),
		inputStateForTab: (tabId) => messages.inputStateForTab?.(tabId) ?? { text: editor.text, cursor: editor.cursor },
		setInputStateForTab: (tabId, state) => {
			if (messages.setInputStateForTab) messages.setInputStateForTab(tabId, state);
			else editor.setText(state.text, state.cursor);
		},
		promptEnhancerConfig: () => ({ modelRef: "test/model" }),
		resetInputAfterProgrammaticEdit: () => {},
		setStatus: () => {},
		setSessionStatus: (sessionArg) => messages.setSessionStatus?.(sessionArg),
		setSessionActivity: (activity) => messages.setSessionActivity?.(activity),
		toast: {
			show: () => {},
			success: (message) => messages.successes.push(message),
			warning: (message) => messages.warnings.push(message),
			error: (message) => messages.errors?.push(message),
			info: () => {},
		},
		render: () => {},
	};
}

function emptyMessages(): { warnings: string[]; successes: string[]; errors: string[] } {
	return { warnings: [], successes: [], errors: [] };
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((innerResolve) => {
		resolve = innerResolve;
	});
	return { promise, resolve };
}

function fakeServices(models: Array<{ provider: string; id: string; name?: string }>): never {
	return {
		modelRuntime: {
			reloadConfig: async () => {},
			getModel: (provider: string, id: string) => models.find((model) => model.provider === provider && model.id === id),
			getModels: () => models,
		},
	} as never;
}

function textDelta(delta: string): unknown {
	return { type: "message_update", assistantMessageEvent: { type: "text_delta", delta } };
}

function errorDelta(message: string): unknown {
	return { type: "message_update", assistantMessageEvent: { type: "error", error: { errorMessage: message }, reason: "fallback" } };
}
