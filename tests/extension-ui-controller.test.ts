import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ExtensionUiController } from "../src/app/extensions/extension-ui-controller.js";
import type { Entry, PixMenuController } from "../src/app/types.js";
import { THEMES } from "../src/theme.js";
import type { ToastNotifier } from "../src/ui.js";

describe("ExtensionUiController custom UI", () => {
	it("registers, replaces, suppresses, and clears extension widgets with cleanup", () => {
		const { controller, renders } = createController();
		const disposed: string[] = [];
		const invalidated: string[] = [];
		const content = Object.assign(() => ["first"], {
			dispose: () => disposed.push("first"),
			invalidate: () => invalidated.push("first"),
		});
		const replacement = Object.assign(() => ["second"], {
			dispose: () => disposed.push("second"),
			invalidate: () => invalidated.push("second"),
		});

		controller.setWidget("key", content, { placement: "belowEditor" });
		assert.equal(controller.widgets.get("key")?.placement, "belowEditor");
		(controller.widgets.get("key") as never as { component: typeof content }).component = content;
		controller.setWidget("key", replacement);
		assert.deepEqual(disposed, ["first"]);
		assert.deepEqual(invalidated, ["first"]);
		assert.equal(controller.widgets.get("key")?.placement, "aboveEditor");
		(controller.widgets.get("key") as never as { component: typeof replacement }).component = replacement;
		controller.suppressWidget("key");
		assert.deepEqual(disposed, ["first", "second"]);
		assert.deepEqual(invalidated, ["first", "second"]);
		assert.equal(controller.widgets.size, 0);

		controller.setWidget("ignored", "plain text is not widget content" as never);
		assert.equal(controller.widgets.size, 0);
		assert.ok(renders.count >= 2);
	});

	it("exposes extension theme color helpers", () => {
		const { controller } = createController();
		const theme = controller.createExtensionTheme() as never as {
			fg(color: string, text: string): string;
			bg(color: string, text: string): string;
			bold(text: string): string;
			inverse(text: string): string;
			strikethrough(text: string): string;
			style(text: string, options: { foreground?: string; background?: string; bold?: boolean }): string;
			getFgAnsi(color: string): string;
			getBgAnsi(color: string): string;
			getColorMode(): string;
			getThinkingBorderColor(): (text: string) => string;
			getBashModeBorderColor(): (text: string) => string;
		};

		assert.match(theme.fg("success", "ok"), /ok/u);
		assert.match(theme.bg("warning", "warn"), /warn/u);
		assert.match(theme.bold("bold"), /bold/u);
		assert.match(theme.inverse("inv"), /\x1b\[7m/u);
		assert.match(theme.strikethrough("gone"), /gone/u);
		assert.match(theme.style("styled", { foreground: "syntaxString", background: "popupHeaderBackground", bold: true }), /styled/u);
		assert.notEqual(theme.getFgAnsi("accent"), "");
		assert.notEqual(theme.getBgAnsi("selectedBg"), "");
		assert.equal(theme.getColorMode(), "truecolor");
		assert.match(theme.getThinkingBorderColor()("thinking"), /thinking/u);
		assert.match(theme.getBashModeBorderColor()("bash"), /bash/u);
	});

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

	it("renders after extensions update the terminal title", () => {
		const { controller, renders } = createController();
		const ctx = controller.createExtensionUIContext();

		ctx.setTitle("pi — generated session title");

		assert.equal(process.title, "pi — generated session title");
		assert.equal(renders.count, 1);
	});

	it("renders focused custom UI in the editor area and routes terminal input to it", async () => {
		const { controller, renders } = createController();
		const ctx = controller.createExtensionUIContext();

		const resultPromise = ctx.custom<string>(((_tui, _theme, _keybindings, done) => ({
			handleInput(data: string) {
				if (data === "1") done("one");
			},
			render: () => ["question panel"],
		}) as never));

		await Promise.resolve();
		assert.equal(controller.widgets.size, 0);
		assert.deepEqual(controller.renderActiveCustomUi(80), ["question panel"]);
		assert.equal(controller.handleTerminalInput("1").consume, true);
		assert.equal(await resultPromise, "one");
		assert.equal(controller.renderActiveCustomUi(80), undefined);
		assert.ok(renders.count >= 2);
	});

	it("handles custom UI render, input, mouse, and cleanup failures defensively", async () => {
		const { controller, input } = createController("saved");
		const ctx = controller.createExtensionUIContext();
		let disposed = 0;
		const promise = ctx.custom(() => ({
			render: () => {
				throw new Error("render boom");
			},
			handleInput: () => {
				throw new Error("input boom");
			},
			handleMouse: () => {
				throw new Error("mouse boom");
			},
			usesEditor: () => {
				throw new Error("uses boom");
			},
			dispose: () => {
				disposed += 1;
				throw new Error("dispose boom");
			},
			invalidate: () => {
				throw new Error("invalidate boom");
			},
		} as never));

		await Promise.resolve();
		ctx.setEditorText("changed");
		assert.deepEqual(controller.renderActiveCustomUi(80), ["pix-custom-ui: custom UI render failed: Error: render boom"]);
		assert.equal(controller.activeCustomUiUsesEditor(), false);
		assert.equal(controller.handleCustomUiMouse({ button: 0, x: 1, y: 1, released: true, localRow: 0, localColumn: 0, width: 20 }), true);
		await assert.rejects(promise, /mouse boom/u);
		assert.equal(input.value, "saved");
		assert.equal(disposed, 1);

		const second = ctx.custom(() => ({
			render: () => ["panel"],
			handleInput: () => {
				throw new Error("input boom");
			},
		} as never));
		await Promise.resolve();
		assert.equal(controller.handleTerminalInput("x").consume, true);
		await assert.rejects(second, /input boom/u);
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

		void ctx.custom((() => ({
			handleInput() {
				throw new Error("Ctrl+C should not be delivered to custom UI");
			},
			render: () => ["question panel"],
		})) as never);

		await Promise.resolve();
		assert.deepEqual(controller.handleTerminalInput("\u0003"), { consume: false });
	});
	it("pipes terminal input through extension handlers when no custom UI is active", () => {
		const { controller } = createController();
		const ctx = controller.createExtensionUIContext();
		const unregister = ctx.onTerminalInput((data) => ({ data: `${data}!` }));
		ctx.onTerminalInput((data) => (data.endsWith("!") ? { consume: true } : undefined));

		assert.deepEqual(controller.handleTerminalInput("a"), { consume: true });
		unregister();
		assert.deepEqual(controller.handleTerminalInput("b"), { consume: false });
	});

	it("supports dialogs, editor-backed input, and abort/timeout dismissal", async () => {
		const { controller, input, menu } = createController("draft");
		const ctx = controller.createExtensionUIContext();
		menu.nextSelect = "two";
		assert.equal(await ctx.select("Pick", ["one", "two"]), "two");
		assert.deepEqual(menu.selectCalls[0], { title: "Pick", options: ["one", "two"] });

		menu.nextShow = true;
		assert.equal(await ctx.confirm("Confirm", "Really?"), true);
		assert.equal(menu.showCalls[0]?.options.title, "Confirm");

		const aborted = new AbortController();
		aborted.abort();
		assert.equal(await ctx.select("Nope", ["x"], { signal: aborted.signal }), undefined);
		assert.equal(await ctx.confirm("Nope", "x", { signal: aborted.signal }), false);
		assert.equal(await ctx.input("Nope", "x", { signal: aborted.signal }), undefined);

		const inputPromise = ctx.input("Name", "placeholder");
		await Promise.resolve();
		assert.equal(input.value, "");
		assert.deepEqual(controller.renderActiveCustomUi(18), ["Name", "Placeholder: plac…", "Enter accepts · E…"]);
		input.value = "Ada";
		assert.deepEqual(controller.handleTerminalInput("\n"), { consume: true });
		assert.equal(await inputPromise, "Ada");
		assert.equal(input.value, "draft");

		const editorPromise = ctx.editor("Edit", "prefill");
		await Promise.resolve();
		assert.equal(input.value, "prefill");
		assert.deepEqual(controller.handleTerminalInput("\x1b"), { consume: true });
		assert.equal(await editorPromise, undefined);
		assert.equal(input.value, "draft");
	});

	it("updates editor text, above-input widgets, tools expansion, and context metadata", () => {
		const { controller, input, deleted, entries, renders } = createController("draft");
		entries.push({ id: "tool-1", kind: "tool", toolName: "read", args: {}, status: "done", expanded: false, result: "ok" } as never);
		entries.push({ id: "message-1", kind: "assistant", text: "hello" } as never);
		const ctx = controller.createExtensionUIContext();

		ctx.pasteToEditor("pasted");
		assert.equal(input.value, "pasted");
		ctx.setEditorText("set");
		assert.equal(ctx.getEditorText(), "set");
		ctx.aboveInput.set("above", ["line"]);
		assert.equal(controller.widgets.get("above")?.placement, "aboveEditor");
		ctx.aboveInput.clear("above");
		assert.equal(controller.widgets.has("above"), false);
		ctx.setWidget("below", ["line"], { placement: "belowEditor" });
		assert.equal(controller.widgets.get("below")?.placement, "belowEditor");

		assert.equal(ctx.getToolsExpanded(), false);
		ctx.setToolsExpanded(true);
		assert.equal((entries[0] as { expanded: boolean }).expanded, true);
		assert.deepEqual(deleted, ["tool-1"]);
		assert.ok(ctx.getAllThemes().some((theme) => theme.name === "dark"));
		assert.equal(ctx.getTheme("dark"), undefined);
		assert.equal(ctx.setTheme("dark").success, false);
		assert.equal(ctx.addAutocompleteProvider?.(() => undefined as never), undefined);
		assert.equal(ctx.getEditorComponent?.(), undefined);
		assert.ok(renders.count >= 4);
	});

});

function createController(initialInput = ""): {
	controller: ExtensionUiController;
	renders: { count: number };
	input: { value: string };
	statuses: { set: string[]; restored: number };
	toasts: { message: string; kind: string | undefined }[];
	menu: PixMenuController & { nextShow?: unknown; nextSelect?: string; showCalls: Array<{ items: unknown[]; options: { title?: string } }>; selectCalls: Array<{ title: string; options: string[] }> };
	entries: Entry[];
	deleted: string[];
} {
	const entries: Entry[] = [];
	const deleted: string[] = [];
	const renders = { count: 0 };
	const input = { value: initialInput };
	const statuses = { set: [] as string[], restored: 0 };
	const toasts: { message: string; kind: string | undefined }[] = [];
	const menuController = {
		showCalls: [] as Array<{ items: unknown[]; options: { title?: string } }>,
		selectCalls: [] as Array<{ title: string; options: string[] }>,
		show: async (items: unknown[], options: { title?: string }) => {
			menuController.showCalls.push({ items, options });
			return menuController.nextShow;
		},
		select: async (title: string, options: string[]) => {
			menuController.selectCalls.push({ title, options });
			return menuController.nextSelect;
		},
		close: () => undefined,
	} as PixMenuController & { nextShow?: unknown; nextSelect?: string; showCalls: Array<{ items: unknown[]; options: { title?: string } }>; selectCalls: Array<{ title: string; options: string[] }> };
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
		menu: menuController,
		entries,
		deleted,
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
			deleteConversationEntry: (entryId) => {
				deleted.push(entryId);
			},
		}),
	};
}
