import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ExtensionUiController } from "../src/app/extensions/extension-ui-controller.js";
import type { Entry, PixMenuController } from "../src/app/types.js";
import { InputEditor } from "../src/input-editor.js";
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

	it("keeps the quota-wait countdown in scoped status chrome without repeated toasts or renders", () => {
		const { controller, activeScope, renders, toasts, statuses } = createController();
		activeScope.value = "tab-a";
		const tabA = controller.createExtensionUIContext("tab-a");
		const tabB = controller.createExtensionUIContext("tab-b");

		tabA.setStatus("quota-wait", "⏳ 1h12m · /wait");
		assert.equal(controller.quotaWaitStatusLabel(), "⏳ 1h12m · /wait");
		assert.equal(renders.count, 1);
		tabA.setStatus("quota-wait", "⏳ 1h12m · /wait");
		assert.equal(renders.count, 1, "unchanged countdown must not repaint on every second");

		tabB.setStatus("quota-wait", "⏳ 45m · /wait");
		assert.equal(renders.count, 1, "background tabs must not render in the foreground");
		assert.equal(controller.quotaWaitStatusLabel(), "⏳ 1h12m · /wait");
		activeScope.value = "tab-b";
		assert.equal(controller.quotaWaitStatusLabel(), "⏳ 45m · /wait");

		tabA.setStatus("quota-wait", "⏳ 1h11m · /wait");
		activeScope.value = "tab-a";
		assert.equal(controller.quotaWaitStatusLabel(), "⏳ 1h11m · /wait");
		tabA.setStatus("quota-wait", undefined);
		assert.equal(controller.quotaWaitStatusLabel(), undefined);

		tabA.setStatus("quota-wait", "⏳ 2m · /wait");
		controller.clearWidgets("tab-a");
		assert.equal(controller.quotaWaitStatusLabel(), undefined);
		tabA.setStatus("quota-wait", "⏳ stale · /wait");
		assert.equal(controller.quotaWaitStatusLabel(), undefined, "a disposed extension must not revive stale status");
		assert.deepEqual(toasts, []);
		assert.equal(statuses.restored, 0);
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

	it("keeps custom UI requested by an inactive scope until that tab becomes active", async () => {
		const { controller, activeScope } = createController();
		activeScope.value = "tab-b";
		const ctxA = controller.createExtensionUIContext("tab-a");

		const resultPromise = ctxA.custom<string>(((_tui, _theme, _keybindings, done) => ({
			handleInput(data: string) {
				if (data === "1") done("one");
			},
			render: () => ["question panel"],
		}) as never));

		await Promise.resolve();
		assert.equal(controller.renderActiveCustomUi(80), undefined);
		assert.deepEqual(controller.handleTerminalInput("1"), { consume: false });

		activeScope.value = "tab-a";
		assert.deepEqual(controller.renderActiveCustomUi(80), ["question panel"]);
		assert.equal(controller.handleTerminalInput("1").consume, true);
		assert.equal(await resultPromise, "one");
	});

	it("reserves async custom UI immediately and keeps it pending while its scope is inactive", async () => {
		const { controller, activeScope, input } = createController("tab a draft");
		activeScope.value = "tab-a";
		const ctxA = controller.createExtensionUIContext("tab-a");
		let resolveFactory!: (component: { render(): string[]; dispose(): void }) => void;
		let done!: (value: string) => void;
		let disposed = 0;
		const first = ctxA.custom<string>((async (_tui, _theme, _keys, complete) => await new Promise((resolve) => {
			done = complete;
			resolveFactory = resolve;
		})) as never);

		activeScope.value = "tab-b";
		input.value = "tab b draft";
		resolveFactory({ render: () => ["late panel"], dispose: () => { disposed += 1; } });

		await new Promise<void>((resolve) => setImmediate(resolve));
		assert.equal(disposed, 0);
		assert.equal(input.value, "tab b draft");
		assert.equal(controller.renderActiveCustomUi(80), undefined);
		activeScope.value = "tab-a";
		input.value = "tab a restored draft";
		assert.deepEqual(controller.renderActiveCustomUi(80), ["late panel"]);
		done("answered");
		assert.equal(await first, "answered");
		assert.equal(input.value, "tab a draft");
		assert.equal(disposed, 1);
	});

	it("ignores late completion from a canceled reservation without closing its replacement", async () => {
		const { controller } = createController("draft");
		let resolveOldFactory!: (component: { render(): string[]; dispose(): void }) => void;
		let oldDone!: (value: string) => void;
		let newDone!: (value: string) => void;
		let oldDisposed = 0;
		const ctx = controller.createExtensionUIContext();
		const oldPromise = ctx.custom<string>((async (_tui, _theme, _keys, done) => {
			oldDone = done;
			return await new Promise((resolve) => { resolveOldFactory = resolve; });
		}) as never);

		controller.cancelCustomUi();
		assert.equal(await oldPromise, undefined);
		const replacement = ctx.custom<string>(((_tui, _theme, _keys, done) => {
			newDone = done;
			return { render: () => ["replacement"] };
		}) as never);
		await Promise.resolve();
		resolveOldFactory({ render: () => ["old"], dispose: () => { oldDisposed += 1; } });
		oldDone("stale");
		await new Promise<void>((resolve) => setImmediate(resolve));

		assert.deepEqual(controller.renderActiveCustomUi(80), ["replacement"]);
		assert.equal(oldDisposed, 1);
		newDone("new");
		assert.equal(await replacement, "new");
	});

	it("does not let a stale extension context edit the active tab", () => {
		const { controller, activeScope, input } = createController("tab b draft");
		activeScope.value = "tab-b";
		const ctxA = controller.createExtensionUIContext("tab-a");

		ctxA.setEditorText("stale text");
		ctxA.pasteToEditor("stale paste");

		assert.equal(input.value, "tab b draft");
		assert.equal(ctxA.getEditorText(), "");
	});

	it("shows extension widgets only in their tab scope", () => {
		const { controller, activeScope } = createController();
		const ctxA = controller.createExtensionUIContext("tab-a");
		const ctxB = controller.createExtensionUIContext("tab-b");

		ctxA.setWidget("question", ["tab a question"]);
		ctxB.setWidget("question", ["tab b question"], { placement: "belowEditor" });

		activeScope.value = "tab-a";
		assert.equal(controller.widgets.get("question")?.placement, "aboveEditor");
		activeScope.value = "tab-b";
		assert.equal(controller.widgets.get("question")?.placement, "belowEditor");
		controller.clearWidgets("tab-b");
		assert.equal(controller.widgets.size, 0);
		activeScope.value = "tab-a";
		assert.equal(controller.widgets.has("question"), true);
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

	it("exposes resolved editor snapshots and restores the attachment-rich draft", async () => {
		const { controller, editor } = createController("draft: ");
		editor.attachPastedText("original line 1\noriginal line 2");
		const savedDraft = editor.draftState;
		const ctx = controller.createExtensionUIContext();
		let done!: (value: string) => void;

		const resultPromise = ctx.custom<string>(((_tui, _theme, _keybindings, complete) => {
			done = complete;
			return { render: () => ["question panel"], usesEditor: () => true };
		}) as never);
		await Promise.resolve();

		ctx.setEditorSnapshot({
			text: "custom line 1\ncustom line 2",
			images: [{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" }],
		});
		assert.match(editor.text, /\[Image 1\]/u);
		assert.deepEqual(ctx.getEditorSnapshot(), {
			text: "custom line 1\ncustom line 2",
			images: [{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" }],
		});

		done("answered");
		assert.equal(await resultPromise, "answered");
		assert.deepEqual(editor.draftState, savedDraft);
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

describe("ExtensionUiController concurrent dialogs", () => {
	it("stacks custom UIs: the newer one hides the older, closing it shows the older again", async () => {
		const { controller } = createController();
		const ctx = controller.createExtensionUIContext();
		const inputsA: string[] = [];
		let doneA!: (value: string) => void;
		let doneB!: (value: string) => void;
		let disposedA = 0;

		const first = ctx.custom<string>(((_tui, _theme, _keys, done) => {
			doneA = done;
			return { render: () => ["panel A"], handleInput: (data: string) => { inputsA.push(data); }, dispose: () => { disposedA += 1; } };
		}) as never);
		await Promise.resolve();
		const second = ctx.custom<string>(((_tui, _theme, _keys, done) => {
			doneB = done;
			return { render: () => ["panel B"] };
		}) as never);
		await Promise.resolve();

		assert.deepEqual(controller.renderActiveCustomUi(80), ["panel B"]);
		controller.handleTerminalInput("x");
		assert.deepEqual(inputsA, [], "hidden dialogs receive no input");

		doneB("b");
		assert.equal(await second, "b");
		assert.equal(disposedA, 0, "the hidden dialog stays alive");
		assert.deepEqual(controller.renderActiveCustomUi(80), ["panel A"]);
		controller.handleTerminalInput("y");
		assert.deepEqual(inputsA, ["y"]);

		doneA("a");
		assert.equal(await first, "a");
		assert.equal(disposedA, 1);
		assert.equal(controller.renderActiveCustomUi(80), undefined);
	});

	it("restores nested editor drafts in LIFO order", async () => {
		const { controller, input } = createController("draft");
		const ctx = controller.createExtensionUIContext();

		const name = ctx.input("Name");
		await Promise.resolve();
		input.value = "Ada";
		const note = ctx.editor("Note", "prefill");
		await Promise.resolve();
		assert.equal(input.value, "prefill");
		assert.equal(controller.renderActiveCustomUi(80)?.[0], "Note");

		input.value = "my note";
		controller.handleTerminalInput("\r");
		assert.equal(await note, "my note");
		assert.equal(input.value, "Ada", "the lower dialog gets its typed text back");
		assert.equal(controller.renderActiveCustomUi(80)?.[0], "Name");

		controller.handleTerminalInput("\r");
		assert.equal(await name, "Ada");
		assert.equal(input.value, "draft");
	});

	it("settles an aborted hidden dialog without disturbing the visible one and hands its draft upward", async () => {
		const { controller, input } = createController("draft");
		const ctx = controller.createExtensionUIContext();
		const abort = new AbortController();

		const lower = ctx.input("Lower", undefined, { signal: abort.signal });
		await Promise.resolve();
		const upper = ctx.input("Upper");
		await Promise.resolve();
		input.value = "upper text";

		abort.abort();
		assert.equal(await lower, undefined);
		assert.equal(input.value, "upper text", "the visible dialog keeps its editor text");
		assert.equal(controller.renderActiveCustomUi(80)?.[0], "Upper");

		controller.handleTerminalInput("\r");
		assert.equal(await upper, "upper text");
		assert.equal(input.value, "draft", "the original draft survives the out-of-order close");
		assert.equal(controller.renderActiveCustomUi(80), undefined);
	});

	it("suspends a select under a newer custom UI and shows it again afterwards", async () => {
		const { controller, menu } = createController();
		const popup = installControllableMenu(menu);
		const ctx = controller.createExtensionUIContext();
		let doneCustom!: (value: string) => void;

		const selected = ctx.select("Pick", ["one", "two"]);
		assert.equal(popup.title(), "Pick");

		const custom = ctx.custom<string>(((_tui, _theme, _keys, done) => {
			doneCustom = done;
			return { render: () => ["panel"] };
		}) as never);
		await Promise.resolve();
		assert.equal(popup.title(), undefined, "the select popup is hidden, not answered");
		assert.deepEqual(controller.renderActiveCustomUi(80), ["panel"]);

		doneCustom("done");
		assert.equal(await custom, "done");
		assert.equal(popup.title(), "Pick", "the select is shown again");
		popup.pick("two");
		assert.equal(await selected, "two");
		assert.equal(popup.title(), undefined);
	});

	it("hides a custom UI while a newer select is on top and routes input back after it closes", async () => {
		const { controller, menu } = createController();
		const popup = installControllableMenu(menu);
		const ctx = controller.createExtensionUIContext();
		const inputs: string[] = [];

		void ctx.custom(((() => ({ render: () => ["panel"], handleInput: (data: string) => { inputs.push(data); } })) as never));
		await Promise.resolve();
		const confirmed = ctx.confirm("Sure?", "really");
		assert.equal(popup.title(), "Sure?");
		assert.equal(controller.renderActiveCustomUi(80), undefined);
		assert.deepEqual(controller.handleTerminalInput("x"), { consume: false }, "the popup owns input");
		assert.deepEqual(inputs, []);

		popup.pick(true);
		assert.equal(await confirmed, true);
		assert.deepEqual(controller.renderActiveCustomUi(80), ["panel"]);
		controller.handleTerminalInput("y");
		assert.deepEqual(inputs, ["y"]);
	});

	it("stacks select over confirm: Esc on the top answers only the top dialog", async () => {
		const { controller, menu } = createController();
		const popup = installControllableMenu(menu);
		const ctx = controller.createExtensionUIContext();

		const first = ctx.confirm("First", "really");
		const second = ctx.select("Second", ["a", "b"]);
		assert.equal(popup.title(), "Second");

		popup.dismiss();
		assert.equal(await second, undefined);
		assert.equal(popup.title(), "First", "the earlier dialog is still pending and visible again");
		popup.pick(true);
		assert.equal(await first, true);
	});

	it("ignores late completion from a hidden dialog's superseded host popup", async () => {
		const { controller, menu } = createController();
		const popup = installControllableMenu(menu);
		const ctx = controller.createExtensionUIContext();
		let settled = false;

		const first = ctx.select("First", ["x"]);
		void first.then(() => { settled = true; });
		const staleResolve = popup.currentResolve();
		const second = ctx.select("Second", ["y"]);
		staleResolve("x");
		await Promise.resolve();
		await Promise.resolve();
		assert.equal(settled, false, "a stale popup resolution must not answer the hidden dialog");
		assert.equal(popup.title(), "Second");

		popup.pick("y");
		assert.equal(await second, "y");
		popup.pick("x");
		assert.equal(await first, "x");
	});

	it("cancels the whole stack on scope cleanup and restores the original draft", async () => {
		const { controller, menu, input } = createController("draft");
		const popup = installControllableMenu(menu);
		const ctx = controller.createExtensionUIContext();

		const name = ctx.input("Name");
		await Promise.resolve();
		input.value = "typed";
		const picked = ctx.select("Pick", ["a"]);
		const note = ctx.editor("Note", "prefill");
		await Promise.resolve();

		controller.cancelCustomUi();
		assert.deepEqual(await Promise.all([name, picked, note]), [undefined, undefined, undefined]);
		assert.equal(input.value, "draft");
		assert.equal(controller.renderActiveCustomUi(80), undefined);
		assert.equal(popup.title(), undefined);
	});

	it("cancels a select that resurfaces while its scope is inactive", async () => {
		const { controller, menu, activeScope } = createController();
		const popup = installControllableMenu(menu);
		activeScope.value = "tab-a";
		const ctx = controller.createExtensionUIContext("tab-a");
		let doneCustom!: (value: string) => void;

		const selected = ctx.select("Pick", ["one"]);
		const custom = ctx.custom<string>(((_tui, _theme, _keys, done) => {
			doneCustom = done;
			return { render: () => ["panel"] };
		}) as never);
		await Promise.resolve();
		activeScope.value = "tab-b";

		doneCustom("ok");
		assert.equal(await custom, "ok");
		assert.equal(await selected, undefined);
		assert.equal(popup.title(), undefined, "an inactive scope never opens the shared popup");
	});
});

/** Single-slot popup mock with real replace/close semantics, like the host SDK menu. */
function installControllableMenu(menu: PixMenuController): {
	title(): string | undefined;
	pick(value: unknown): void;
	dismiss(): void;
	currentResolve(): (value: unknown) => void;
} {
	let current: { title: string | undefined; resolve(value: unknown): void } | undefined;
	const open = (title: string | undefined): Promise<unknown> => {
		current?.resolve(undefined);
		return new Promise((resolve) => {
			current = { title, resolve };
		});
	};
	const settle = (value: unknown): void => {
		const request = current;
		current = undefined;
		request?.resolve(value);
	};
	menu.show = (async (_items: unknown, options: { title?: string }) => await open(options.title)) as PixMenuController["show"];
	menu.select = (async (title: string) => await open(title)) as PixMenuController["select"];
	menu.close = () => settle(undefined);
	return {
		title: () => current?.title,
		pick: settle,
		dismiss: () => settle(undefined),
		currentResolve: () => {
			const request = current;
			if (!request) throw new Error("no open popup");
			return (value) => request.resolve(value);
		},
	};
}

function createController(initialInput = ""): {
	controller: ExtensionUiController;
	renders: { count: number };
	input: { value: string };
	editor: InputEditor;
	statuses: { set: string[]; restored: number };
	toasts: { message: string; kind: string | undefined }[];
	menu: PixMenuController & { nextShow?: unknown; nextSelect?: string; showCalls: Array<{ items: unknown[]; options: { title?: string } }>; selectCalls: Array<{ title: string; options: string[] }> };
	entries: Entry[];
	deleted: string[];
	activeScope: { value: string | undefined };
} {
	const entries: Entry[] = [];
	const deleted: string[] = [];
	const renders = { count: 0 };
	const editor = new InputEditor();
	editor.restoreDraftState({ text: initialInput, cursor: initialInput.length });
	const input = {
		get value() { return editor.text; },
		set value(value: string) { editor.setText(value); },
	};
	const statuses = { set: [] as string[], restored: 0 };
	const activeScope = { value: undefined as string | undefined };
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
		editor,
		statuses,
		toasts,
		menu: menuController,
		entries,
		deleted,
		activeScope,
		controller: new ExtensionUiController({
			theme: THEMES.dark,
			activeExtensionUiScope: () => activeScope.value,
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
			setInputState: (state) => editor.restoreDraftState(state),
			getInputState: () => editor.draftState,
			setInputSnapshot: (snapshot) => {
				editor.restoreDraftState({ text: snapshot.text, cursor: snapshot.text.length });
				for (const image of snapshot.images) editor.attachImage(image.data, image.mimeType);
			},
			getInputSnapshot: () => ({
				text: editor.expandedText,
				images: editor.images.map((image) => ({ ...image })),
			}),
			get entries() { return entries; },
			deleteConversationEntry: (entryId) => {
				deleted.push(entryId);
			},
		}),
	};
}
