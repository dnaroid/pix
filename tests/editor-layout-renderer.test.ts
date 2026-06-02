import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { InputEditor } from "../src/input-editor.js";
import { THEMES } from "../src/theme.js";
import { EditorLayoutRenderer } from "../src/app/rendering/editor-layout-renderer.js";
import { APP_ICONS } from "../src/app/icons.js";
import type { ExtensionWidgetRegistration, TodoDetails } from "../src/app/types.js";

describe("EditorLayoutRenderer voice partials", () => {
	it("renders a live voice partial above the editor", () => {
		const renderer = editorLayoutRenderer("hello from vosk");

		const layout = renderer.computeLayout(40, 10);
		const line = layout.aboveEditorLines.at(-1);

		assert.ok(line);
		assert.equal(line.variant, "muted");
		assert.ok(line.text.includes(APP_ICONS.microphone));
		assert.ok(line.text.includes("hello from vosk"));
		assert.equal(line.segments?.[0]?.foreground, THEMES.dark.colors.error);
	});

	it("does not reserve a row when no voice partial exists", () => {
		const renderer = editorLayoutRenderer(undefined);

		const layout = renderer.computeLayout(40, 10);

		assert.equal(layout.aboveEditorLines.length, 0);
	});
});

describe("EditorLayoutRenderer extension input UI", () => {
	it("reports input scrollbar metrics for overflowed editor content", () => {
		const inputEditor = new InputEditor();
		inputEditor.setText("one\ntwo\nthree\nfour\nfive");
		inputEditor.setVisualScrollOffset(2, 38, 3, "", "");
		const renderer = editorLayoutRenderer(undefined, { inputEditor });

		const layout = renderer.computeLayout(40, 8);

		assert.equal(layout.renderedInput.totalLineCount, 5);
		assert.equal(layout.renderedInput.visibleRowCount, 3);
		assert.deepEqual(layout.renderedInput.scrollBar, { top: 1, height: 2, trackHeight: 3 });
	});

	it("reserves above-editor widget rows with a spacer inside the input frame", () => {
		const renderer = editorLayoutRenderer(undefined, {
			extensionWidgets: new Map([["test-widget", {
				key: "test-widget",
				placement: "aboveEditor",
				content: ["Widget row"],
			}]]),
		});

		const layout = renderer.computeLayout(40, 10);

		assert.equal(layout.aboveEditorLines.length, 2);
		assert.equal(layout.aboveEditorLines[layout.aboveEditorLines.length - 1]?.text, "");
		assert.equal(layout.inputStartRow, layout.inputSeparatorRow + layout.aboveEditorLines.length + 1);
	});

	it("renders above-editor widgets at the inner frame width", () => {
		let renderedWidth: number | undefined;
		const renderer = editorLayoutRenderer(undefined, {
			extensionWidgets: new Map([["test-widget", {
				key: "test-widget",
				placement: "aboveEditor",
				content: () => ({
					render: (width: number) => {
						renderedWidth = width;
						return ["x".repeat(width)];
					},
				}),
			}]]),
		});

		const layout = renderer.computeLayout(12, 10);

		assert.equal(renderedWidth, 10);
		assert.equal(layout.aboveEditorLines[0]?.text, "x".repeat(10));
	});

	it("suppresses and disposes legacy todo widgets when the built-in todo panel is active", () => {
		let disposed = 0;
		const todoDetails: TodoDetails = {
			action: "list",
			params: {},
			nextId: 2,
			tasks: [{ id: 1, subject: "Current", status: "in_progress" }],
		};
		const extensionWidgets = new Map<string, ExtensionWidgetRegistration>([["rpiv-todos", {
			key: "rpiv-todos",
			placement: "aboveEditor",
			content: ["legacy todo widget"],
			component: {
				render: () => ["legacy todo widget"],
				dispose: () => {
					disposed += 1;
				},
			},
		}]]);
		const renderer = editorLayoutRenderer(undefined, {
			todoDetails,
			todoPanelExpanded: false,
			extensionWidgets,
			suppressExtensionWidget: (key) => {
				const widget = extensionWidgets.get(key);
				widget?.component?.dispose?.();
				extensionWidgets.delete(key);
			},
		});

		const layout = renderer.computeLayout(80, 10);

		assert.ok(layout.aboveEditorLines[0]?.text.includes("Current"));
		assert.equal(layout.aboveEditorLines.some((line) => line.text.includes("legacy todo widget")), false);
		assert.equal(extensionWidgets.has("rpiv-todos"), false);
		assert.equal(disposed, 1);
	});

	it("does not reserve an input spacer without widgets", () => {
		const renderer = editorLayoutRenderer("voice only");

		const layout = renderer.computeLayout(40, 10);

		assert.equal(layout.aboveEditorLines.length, 1);
		assert.ok(layout.aboveEditorLines[0]?.text.includes("voice only"));
	});

	it("renders focused extension UI as input content without reserving above-editor rows", () => {
		const renderer = editorLayoutRenderer(undefined, {
			renderExtensionInputComponent: () => ["Question panel"],
			extensionInputUsesEditor: () => false,
		});

		const layout = renderer.computeLayout(40, 10);

		assert.equal(layout.aboveEditorLines.length, 0);
		assert.ok(layout.renderedInput.lines[0]?.includes("Question panel"));
		assert.equal(layout.renderedInput.cursorVisible, false);
		assert.equal(layout.renderedInput.editorStartRowOffset, 1);
	});

	it("can append the shared input editor below extension UI", () => {
		const inputEditor = new InputEditor();
		inputEditor.setText("custom answer");
		const renderer = editorLayoutRenderer(undefined, {
			inputEditor,
			renderExtensionInputComponent: () => ["Custom Answer:"],
			extensionInputUsesEditor: () => true,
		});

		const layout = renderer.computeLayout(40, 10);

		assert.ok(layout.renderedInput.lines[0]?.includes("Custom Answer:"));
		assert.ok(layout.renderedInput.lines[1]?.includes("custom answer"));
		assert.equal(layout.renderedInput.cursorVisible, true);
		assert.equal(layout.renderedInput.editorStartRowOffset, 1);
	});

	it("lets focused extension UI use the available input height", () => {
		const renderer = editorLayoutRenderer(undefined, {
			renderExtensionInputComponent: () => Array.from({ length: 12 }, (_, index) => `Question row ${index + 1}`),
			extensionInputUsesEditor: () => false,
		});

		const layout = renderer.computeLayout(40, 20);

		assert.equal(layout.renderedInput.lines.length, 12);
		assert.ok(layout.renderedInput.lines.at(-1)?.includes("Question row 12"));
	});
});

function editorLayoutRenderer(
	voicePartialText: string | undefined,
	overrides: Partial<ConstructorParameters<typeof EditorLayoutRenderer>[0]> = {},
): EditorLayoutRenderer {
	return new EditorLayoutRenderer(createRendererHost({ voicePartialText, ...overrides }));
}

function createRendererHost(overrides: Partial<ConstructorParameters<typeof EditorLayoutRenderer>[0]> = {}): ConstructorParameters<typeof EditorLayoutRenderer>[0] {
	return {
		theme: THEMES.dark,
		inputEditor: overrides.inputEditor ?? new InputEditor(),
		extensionWidgets: overrides.extensionWidgets ?? new Map(),
		todoDetails: overrides.todoDetails,
		todoPanelExpanded: false,
		subagentsPanelExpanded: false,
		subagentsWidgetState: undefined,
		voicePartialText: overrides.voicePartialText,
		renderExtensionInputComponent: overrides.renderExtensionInputComponent ?? (() => undefined),
		extensionInputUsesEditor: overrides.extensionInputUsesEditor ?? (() => false),
		widgetTuiHandle: () => ({}) as never,
		createExtensionTheme: () => ({}) as never,
		suppressExtensionWidget: overrides.suppressExtensionWidget ?? (() => undefined),
	};
}
