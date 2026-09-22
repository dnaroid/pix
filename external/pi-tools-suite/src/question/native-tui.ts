import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";

import {
	clearNativePiNearEditorWidget,
	setNativePiNearEditorWidget,
} from "../lib/native-pi-widget-order.js";
import { createQuestionnaireComponent } from "./tui.js";
import type {
	NormalizedQuestion,
	QuestionComponent,
	QuestionSelection,
	QuestionUiContext,
} from "./types.js";

export const QUESTION_NATIVE_WIDGET_KEY = "pi-tools-suite:question";

export function runNativePiQuestionnaire(
	questions: NormalizedQuestion[],
	ctx: ExtensionContext,
	signal?: AbortSignal,
): Promise<QuestionSelection[] | null> {
	return new Promise((resolve, reject) => {
		let questionComponent: QuestionComponent | undefined;
		let widgetComponent: Component | undefined;
		let unsubscribeInput: (() => void) | undefined;
		let settled = false;

		const cleanup = () => {
			unsubscribeInput?.();
			unsubscribeInput = undefined;
			signal?.removeEventListener("abort", onAbort);
			clearNativePiNearEditorWidget(ctx, QUESTION_NATIVE_WIDGET_KEY);
		};

		const finish = (value: QuestionSelection[] | null) => {
			if (settled) return;
			settled = true;
			cleanup();
			resolve(value);
		};

		const onAbort = () => {
			if (settled) return;
			settled = true;
			cleanup();
			const reason = signal?.reason;
			reject(reason instanceof Error ? reason : new Error("Questionnaire aborted"));
		};

		const factory = (tui: TUI, theme: Theme): Component => {
			if (!questionComponent) {
				questionComponent = createQuestionnaireComponent(
					questions,
					ctx as unknown as QuestionUiContext,
					tui,
					theme,
					finish,
				);
			}
			if (!widgetComponent) {
				widgetComponent = {
					invalidate() {
						questionComponent?.invalidate();
					},
					render(width: number) {
						return questionComponent?.render(width) ?? [];
					},
				};
			}
			return widgetComponent;
		};

		setNativePiNearEditorWidget(ctx, QUESTION_NATIVE_WIDGET_KEY, factory);
		unsubscribeInput = ctx.ui.onTerminalInput((data) => {
			// Let Pi's normal interrupt handling keep ownership of Ctrl+C.
			if (data === "\u0003") return { consume: false };
			const result = questionComponent?.handleInput(data);
			if (result && typeof result === "object" && result.consume === false) {
				return {
					consume: false,
					...(result.data === undefined ? {} : { data: result.data }),
				};
			}
			return { consume: true };
		});
		if (signal) {
			if (signal.aborted) onAbort();
			else signal.addEventListener("abort", onAbort, { once: true });
		}
	});
}
