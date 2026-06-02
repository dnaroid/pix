import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { APP_ICONS } from "../src/app/icons.js";
import { AppPromptEnhancerController, type AppPromptEnhancerControllerHost } from "../src/app/input/prompt-enhancer-controller.js";
import { InputEditor } from "../src/input-editor.js";

describe("AppPromptEnhancerController", () => {
	it("shows only the hourglass while enhancement is running", () => {
		const controller = new AppPromptEnhancerController({} as AppPromptEnhancerControllerHost);
		(controller as unknown as { enhancing: boolean }).enhancing = true;

		assert.equal(controller.statusWidgetText(), APP_ICONS.timerSand);
		assert.ok(!controller.statusWidgetText().includes(APP_ICONS.autoFix));
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
});

function createHost(
	editor: InputEditor,
	messages: {
		warnings: string[];
		successes: string[];
		activeInputTabId?: () => string | undefined;
		inputStateForTab?: (tabId: string | undefined) => { text: string; cursor: number } | undefined;
		setInputStateForTab?: (tabId: string | undefined, state: { text: string; cursor: number }) => void;
	},
): AppPromptEnhancerControllerHost {
	const session = { isStreaming: false, isCompacting: false };
	return {
		runtime: () => ({ cwd: "/tmp", session }) as unknown as ReturnType<AppPromptEnhancerControllerHost["runtime"]>,
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
		setSessionStatus: () => {},
		setSessionActivity: () => {},
		toast: {
			show: () => {},
			success: (message) => messages.successes.push(message),
			warning: (message) => messages.warnings.push(message),
			error: () => {},
			info: () => {},
		},
		render: () => {},
	};
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((innerResolve) => {
		resolve = innerResolve;
	});
	return { promise, resolve };
}
