import { Text, truncateToWidth } from "@earendil-works/pi-tui";

import type { QuestionTheme, QuestionToolInput, QuestionToolResult } from "./types.js";

export function renderQuestionCall(args: Partial<QuestionToolInput>, theme: QuestionTheme): Text {
	const questions = Array.isArray(args.questions) ? args.questions : [];
	const count = questions.length;
	const labels = questions.map((question) => question?.label || question?.id).filter((label): label is string => typeof label === "string" && label.length > 0).join(", ");
	let text = theme.fg("toolTitle", (theme.bold ?? ((value: string) => value))("question "));
	text += theme.fg("muted", `${count} question${count === 1 ? "" : "s"}`);
	if (labels) text += theme.fg("dim", ` (${truncateToWidth(labels, 48)})`);
	return new Text(text, 0, 0);
}

export function renderQuestionResult(result: Partial<QuestionToolResult>, theme: QuestionTheme, args?: Partial<QuestionToolInput>): Text {
	const details = result.details;
	if (!details) {
		const firstContent = result.content?.[0];
		return new Text(firstContent?.type === "text" ? firstContent.text : "", 0, 0);
	}
	if (details.canceled) return new Text(theme.fg("warning", details.reason === "ui_unavailable" ? "Canceled: UI unavailable" : "Canceled"), 0, 0);
	const labels = new Map((Array.isArray(args?.questions) ? args.questions : []).map((question) => [question.id, question.label]));
	return new Text(details.answers.map((answer) => {
		const questionLabel = labels.get(answer.id) ?? answer.id;
		if (answer.wasCustom) return `${theme.fg("success", "✓ ")}${theme.fg("accent", `${questionLabel}:`)} ${theme.fg("muted", "custom ")}${answer.label}`;
		return `${theme.fg("success", "✓ ")}${theme.fg("accent", `${questionLabel}:`)} ${answer.index}. ${answer.label}`;
	}).join("\n"), 0, 0);
}
