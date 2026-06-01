import { throwInvalid } from "./contract";
import type { CanceledQuestionResult, NormalizedQuestion, QuestionResultDetails, QuestionSelection, QuestionToolResult, SuccessfulQuestionResult } from "./types";

export function createSuccessfulQuestionResult(questions: NormalizedQuestion[], selections: QuestionSelection[]): SuccessfulQuestionResult {
	const selectionsById = new Map(selections.map((selection) => [selection.id, selection]));
	return {
		answers: questions.map((question) => {
			const selection = selectionsById.get(question.id);
			if (!selection) throwInvalid(`Missing answer for question "${question.id}".`, "Retry after collecting one answer for each normalized question.");
			if ("customText" in selection) {
				const customText = selection.customText.trim();
				if (!customText) throwInvalid(`Custom Answer for question "${question.id}" is empty after trimming.`, "Retry with non-empty Custom Answer text or choose a predefined Choice.");
				return {
					id: question.id,
					value: customText,
					label: customText,
					wasCustom: true,
				};
			}

			const choiceIndex = question.choices.findIndex((choice) => choice.value === selection.choiceValue);
			if (choiceIndex === -1) throwInvalid(`Question "${question.id}" has no predefined Choice with value "${selection.choiceValue}".`, "Retry with one of the normalized predefined Choice values for that question.");
			const choice = question.choices[choiceIndex]!;
			return {
				id: question.id,
				value: choice.value,
				label: choice.label,
				wasCustom: false,
				index: choiceIndex + 1,
			};
		}),
		canceled: false,
	};
}

export function createCanceledQuestionResult(reason: CanceledQuestionResult["reason"], questions: NormalizedQuestion[] = []): CanceledQuestionResult {
	return {
		answers: [],
		canceled: true,
		reason,
		...(reason === "ui_unavailable" && questions.length > 0 ? { fallbackPrompt: createFallbackPrompt(questions) } : {}),
	};
}

export function createFallbackPrompt(questions: NormalizedQuestion[]): string {
	const lines = [
		"Interactive UI is unavailable. Ask the user these structured questions in normal chat instead, then use the user's replies without inventing answers.",
	];
	questions.forEach((question, index) => {
		lines.push("", `${index + 1}. ${question.label}: ${question.prompt}`);
		question.choices.forEach((choice, choiceIndex) => {
			const suffix = choice.description ? ` — ${choice.description}` : "";
			lines.push(`   ${choiceIndex + 1}. ${choice.label}${suffix}`);
		});
		lines.push(`   ${question.choices.length + 1}. Something else… (custom answer)`);
	});
	return lines.join("\n");
}

export function summarizeQuestionResult(result: QuestionResultDetails, questions: NormalizedQuestion[] = []): string {
	if (result.canceled) {
		if (result.reason === "ui_unavailable") {
			return result.fallbackPrompt
				? `No interactive UI is available, so question was canceled. Do not assume an answer. Ask the user in normal chat instead.\n\n${result.fallbackPrompt}`
				: "No interactive UI is available, so question was canceled. Do not assume an answer.";
		}
		return "The user canceled question. Do not assume an answer.";
	}
	if (result.answers.length === 0) return "question returned no answers.";
	const questionLabels = new Map(questions.map((question) => [question.id, question.label]));
	return `question answers: ${result.answers.map((answer) => {
		const questionLabel = questionLabels.get(answer.id) ?? answer.id;
		if (answer.wasCustom) return `${questionLabel}: ${answer.label} (custom answer)`;
		return `${questionLabel}: ${answer.label} (choice ${answer.index})`;
	}).join("; ")}.`;
}

export function createQuestionToolResult(details: QuestionResultDetails, questions: NormalizedQuestion[] = []): QuestionToolResult {
	return {
		content: [{
			type: "text",
			text: summarizeQuestionResult(details, questions),
		}],
		details,
	};
}
