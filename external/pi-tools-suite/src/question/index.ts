import type { AgentToolResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { isNativePiTui, isPixOwnedHost } from "../lib/native-pi-tui.js";
import { normalizeQuestionInput, questionParameters } from "./contract.js";
import { renderQuestionCall, renderQuestionResult } from "./render.js";
import { createCanceledQuestionResult, createQuestionToolResult, createSuccessfulQuestionResult } from "./result.js";
import { QUESTION_TOOL_DESCRIPTION } from "./tool-description.js";
import { runNativePiQuestionnaire } from "./native-tui.js";
import type { QuestionToolInput, QuestionToolResult } from "./types.js";

export default function questionExtension(pi: ExtensionAPI): void {
	// Pix owns its question tool and Desktop/RPC bridge. Registering this clean-pi
	// implementation there would create a duplicate tool and leak native TUI UI.
	if (isPixOwnedHost()) return;

	pi.registerTool({
		...QUESTION_TOOL_DESCRIPTION,
		parameters: questionParameters,
		executionMode: "sequential",
		renderCall(args, theme) {
			return renderQuestionCall(args as Partial<QuestionToolInput>, theme);
		},
		renderResult(result, _options, theme, context) {
			return renderQuestionResult(
				result as Partial<QuestionToolResult>,
				theme,
				context.args as Partial<QuestionToolInput>,
			);
		},
		async execute(_toolCallId, params, signal, _onUpdate, ctx): Promise<AgentToolResult<unknown>> {
			signal?.throwIfAborted();
			const questions = normalizeQuestionInput(params);
			if (!isNativePiTui(ctx)) {
				return createQuestionToolResult(createCanceledQuestionResult("ui_unavailable", questions), questions);
			}

			const selections = await runNativePiQuestionnaire(questions, ctx, signal);
			if (selections == null) {
				return createQuestionToolResult(createCanceledQuestionResult("user_canceled"), questions);
			}
			const images = selections.flatMap((selection) => "customText" in selection ? selection.images ?? [] : []);
			return createQuestionToolResult(createSuccessfulQuestionResult(questions, selections), questions, images);
		},
	});
}

export { normalizeQuestionInput, questionParameters } from "./contract.js";
export {
	createCanceledQuestionResult,
	createFallbackPrompt,
	createQuestionToolResult,
	createSuccessfulQuestionResult,
	summarizeQuestionResult,
} from "./result.js";
export type { QuestionResultDetails, QuestionToolInput } from "./types.js";
