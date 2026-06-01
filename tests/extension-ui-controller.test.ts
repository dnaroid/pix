import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ExtensionUiController } from "../src/app/extension-ui-controller.js";
import type { Entry, PixMenuController } from "../src/app/types.js";
import { THEMES } from "../src/theme.js";
import type { ToastNotifier } from "../src/ui.js";

describe("ExtensionUiController custom UI", () => {
	it("routes extension status and working messages to toasts instead of the status line", () => {
		const { controller, statuses, toasts } = createController();
		const ctx = controller.createExtensionUIContext();

		ctx.setStatus("dcp:antigravity", "Antigravity switched to user@example.com (5/5)");
		ctx.setWorkingMessage("Extension is working");
		ctx.setStatus("dcp:antigravity", undefined);
		ctx.setWorkingMessage(undefined);

		assert.deepEqual(toasts, [
			{ message: "Antigravity switched to user@example.com (5/5)", kind: "info" },
			{ message: "Extension is working", kind: "info" },
		]);
		assert.deepEqual(statuses.set, []);
		assert.equal(statuses.restored, 4);
	});

	it("renders focused custom UI in the editor area and routes terminal input to it", async () => {
		const { controller, renders } = createController();
		const ctx = controller.createExtensionUIContext();

		const resultPromise = ctx.custom<string>((_tui, _theme, _keybindings, done) => ({
			handleInput(data: string) {
				if (data === "1") done("one");
			},
			render: () => ["question panel"],
		}));

		await Promise.resolve();
		assert.equal(controller.widgets.size, 0);
		assert.deepEqual(controller.renderActiveCustomUi(80), ["question panel"]);
		assert.equal(controller.handleTerminalInput("1").consume, true);
		assert.equal(await resultPromise, "one");
		assert.equal(controller.renderActiveCustomUi(80), undefined);
		assert.ok(renders.count >= 2);
	});

	it("restores saved input when custom UI completes", async () => {
		const { controller, input } = createController("draft");
		const ctx = controller.createExtensionUIContext();

		const resultPromise = ctx.custom<string>((_tui, _theme, _keybindings, done) => ({
			handleInput(data: string) {
				if (data === "done") done("ok");
			},
			render: () => ["question panel"],
			usesEditor: () => true,
		} as never));

		await Promise.resolve();
		ctx.setEditorText("custom answer");
		assert.equal(input.value, "custom answer");
		assert.equal(controller.activeCustomUiUsesEditor(), true);

		controller.handleTerminalInput("done");
		assert.equal(await resultPromise, "ok");
		assert.equal(input.value, "draft");
	});

	it("allows focused custom UI to delegate input back to the editor", async () => {
		const { controller } = createController();
		const ctx = controller.createExtensionUIContext();

		void ctx.custom(() => ({
			handleInput() {
				return { consume: false };
			},
			render: () => ["question panel"],
		} as never));

		await Promise.resolve();
		assert.deepEqual(controller.handleTerminalInput("a"), { consume: false });
	});

	it("routes mouse clicks to focused custom UI", async () => {
		const { controller } = createController();
		const ctx = controller.createExtensionUIContext();
		let clicked: unknown;

		void ctx.custom(() => ({
			handleMouse(event: unknown) {
				clicked = event;
				return true;
			},
			render: () => ["question panel"],
		} as never));

		await Promise.resolve();
		assert.equal(controller.handleCustomUiMouse({ button: 0, x: 5, y: 10, released: true, localRow: 1, localColumn: 2, width: 80 }), true);
		assert.deepEqual(clicked, { button: 0, x: 5, y: 10, released: true, localRow: 1, localColumn: 2, width: 80 });
	});

	it("lets Ctrl+C pass through the focused custom widget", async () => {
		const { controller } = createController();
		const ctx = controller.createExtensionUIContext();

		void ctx.custom(() => ({
			handleInput() {
				throw new Error("Ctrl+C should not be delivered to custom UI");
			},
			render: () => ["question panel"],
		}));

		await Promise.resolve();
		assert.deepEqual(controller.handleTerminalInput("\u0003"), { consume: false });
	});
});

function createController(initialInput = ""): {
	controller: ExtensionUiController;
	renders: { count: number };
	input: { value: string };
	statuses: { set: string[]; restored: number };
	toasts: { message: string; kind: string | undefined }[];
} {
	const entries: Entry[] = [];
	const renders = { count: 0 };
	const input = { value: initialInput };
	const statuses = { set: [] as string[], restored: 0 };
	const toasts: { message: string; kind: string | undefined }[] = [];
	const menuController: PixMenuController = {
		show: async () => undefined,
		select: async () => undefined,
		close: () => undefined,
	};
	const toastNotifier: ToastNotifier = {
		show: () => undefined,
		success: () => undefined,
		error: () => undefined,
		warning: () => undefined,
		info: () => undefined,
	};

	return {
		renders,
		input,
		statuses,
		toasts,
		controller: new ExtensionUiController({
			theme: THEMES.dark,
			isRunning: () => true,
			render: () => {
				renders.count += 1;
			},
			showToast: (message, kind) => {
				toasts.push({ message, kind });
			},
			toastNotifier,
			menuController,
			setStatus: (status) => {
				statuses.set.push(status);
			},
			restoreSessionStatus: () => {
				statuses.restored += 1;
			},
			setInput: (value) => {
				input.value = value;
			},
			getInput: () => input.value,
			get entries() { return entries; },
			deleteConversationEntry: () => undefined,
		}),
	};
}
