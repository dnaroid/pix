import { QUESTION_TOOL_DESCRIPTION } from "./tool-description";
import { questionParameters, normalizeQuestionInput } from "./contract";
import { renderQuestionCall, renderQuestionResult } from "./render";
import { createCanceledQuestionResult, createQuestionToolResult, createSuccessfulQuestionResult } from "./result";
import { runQuestionnaire } from "./tui";
import type { QuestionToolInput, QuestionUiContext } from "./types";

interface ExtensionApiLike {
	registerTool(tool: unknown): void;
}

export default function questionExtension(pi: ExtensionApiLike): void {
	pi.registerTool({
		...QUESTION_TOOL_DESCRIPTION,
		parameters: questionParameters,
		renderCall(args: Partial<QuestionToolInput>, theme: any) {
			return renderQuestionCall(args, theme);
		},
		renderResult(result: any, _options: unknown, theme: any, context: { args?: Partial<QuestionToolInput> }) {
			return renderQuestionResult(result, theme, context.args);
		},
		async execute(_toolCallId: string, params: QuestionToolInput, _signal: AbortSignal | undefined, _onUpdate: unknown, ctx: QuestionUiContext) {
			const questions = normalizeQuestionInput(params);
			if (!ctx.hasUI) return createQuestionToolResult(createCanceledQuestionResult("ui_unavailable", questions), questions);
			const selections = await runQuestionnaire(questions, ctx);
			if (selections === null) return createQuestionToolResult(createCanceledQuestionResult("user_canceled"), questions);
			return createQuestionToolResult(createSuccessfulQuestionResult(questions, selections), questions);
		},
	});
}

export { questionParameters, normalizeQuestionInput } from "./contract";
export { createCanceledQuestionResult, createFallbackPrompt, createQuestionToolResult, createSuccessfulQuestionResult, summarizeQuestionResult } from "./result";
export type { QuestionResultDetails, QuestionToolInput } from "./types";
