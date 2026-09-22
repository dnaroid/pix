import { throwInvalid } from "./contract.js";
import type { CanceledQuestionResult, MultipleQuestionSelection, NormalizedQuestion, QuestionAnswerSelection, QuestionImageContent, QuestionResultDetails, QuestionSelection, QuestionToolResult, SuccessfulQuestionResult } from "./types.js";

function formatAttachedImages(count: number): string {
	return `${count} image${count === 1 ? "" : "s"} attached`;
}

export function createSuccessfulQuestionResult(questions: NormalizedQuestion[], selections: QuestionSelection[]): SuccessfulQuestionResult {
	if (selections.length !== questions.length) throwInvalid(`Expected ${questions.length} question selections; received ${selections.length}.`, "Retry with exactly one grouped selection for each normalized question.");
	const questionIds = new Set(questions.map((question) => question.id));
	const seenSelectionIds = new Set<string>();
	for (const selection of selections) {
		if (!questionIds.has(selection.id)) throwInvalid(`Received an answer for unknown question "${selection.id}".`, "Retry with only normalized question ids.");
		if (seenSelectionIds.has(selection.id)) throwInvalid(`Received duplicate grouped answers for question "${selection.id}".`, "Retry with one grouped selection for each question.");
		seenSelectionIds.add(selection.id);
	}
	const selectionsById = new Map(selections.map((selection) => [selection.id, selection]));
	return {
		answers: questions.map((question) => {
			const selection = selectionsById.get(question.id);
			if (!selection) throwInvalid(`Missing answer for question "${question.id}".`, "Retry after collecting one answer for each normalized question.");
			if (question.multiple) {
				if (!("choiceValues" in selection)) throwInvalid(`Question "${question.id}" requires multiple selections.`, "Retry with choiceValues and an optional custom answer for this multi-select question.");
				return {
					id: question.id,
					multiple: true as const,
					selections: createMultipleAnswerSelections(question, selection),
				};
			}
			if ("choiceValues" in selection) throwInvalid(`Question "${question.id}" accepts only one selection.`, "Retry with one choiceValue or one custom answer for this single-select question.");
			if ("customText" in selection) {
				return {
					id: question.id,
					...createCustomAnswerSelection(question.id, selection.customText, selection.images),
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

function createMultipleAnswerSelections(question: NormalizedQuestion, selection: MultipleQuestionSelection): QuestionAnswerSelection[] {
	const uniqueValues = new Set(selection.choiceValues);
	if (uniqueValues.size !== selection.choiceValues.length) throwInvalid(`Question "${question.id}" contains duplicate predefined selections.`, "Retry with each choice value at most once.");
	for (const value of uniqueValues) {
		if (!question.choices.some((choice) => choice.value === value)) throwInvalid(`Question "${question.id}" has no predefined Choice with value "${value}".`, "Retry with only normalized predefined Choice values for that question.");
	}
	if (selection.images && selection.customText === undefined) throwInvalid(`Question "${question.id}" includes custom images without a custom answer.`, "Retry with customText, which may be empty for an image-only answer.");

	const answers: QuestionAnswerSelection[] = question.choices.flatMap((choice, index) => (
		uniqueValues.has(choice.value)
			? [{ value: choice.value, label: choice.label, wasCustom: false, index: index + 1 }]
			: []
	));
	if (selection.customText !== undefined) answers.push(createCustomAnswerSelection(question.id, selection.customText, selection.images));

	const minSelections = question.minSelections ?? 1;
	const maxSelections = question.maxSelections ?? question.choices.length + 1;
	if (answers.length < minSelections || answers.length > maxSelections) {
		throwInvalid(`Question "${question.id}" requires ${minSelections} to ${maxSelections} selections; received ${answers.length}.`, "Retry with a number of answers inside the configured selection limits.");
	}
	return answers;
}

function createCustomAnswerSelection(questionId: string, text: string, images?: QuestionImageContent[]): QuestionAnswerSelection {
	const customText = text.trim();
	const imageCount = images?.length ?? 0;
	if (!customText && imageCount === 0) throwInvalid(`Custom Answer for question "${questionId}" is empty after trimming.`, "Retry with non-empty Custom Answer text, an image, or choose a predefined Choice.");
	const label = customText || formatAttachedImages(imageCount);
	return {
		value: customText || label,
		label,
		wasCustom: true,
		...(imageCount > 0 ? { imageCount } : {}),
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
		if (question.multiple) lines.push(`   Select ${question.minSelections ?? 1} to ${question.maxSelections ?? question.choices.length + 1} answers.`);
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
		if ("multiple" in answer) {
			return `${questionLabel}: ${answer.selections.map((item) => summarizeAnswerSelection(item)).join(", ")}`;
		}
		if (answer.wasCustom) {
			const imageLabel = answer.imageCount ? formatAttachedImages(answer.imageCount) : undefined;
			const imageSuffix = imageLabel && answer.label !== imageLabel ? `; ${imageLabel}` : "";
			return `${questionLabel}: ${answer.label} (custom answer${imageSuffix})`;
		}
		return `${questionLabel}: ${answer.label} (choice ${answer.index})`;
	}).join("; ")}.`;
}

function summarizeAnswerSelection(answer: QuestionAnswerSelection): string {
	if (answer.wasCustom) {
		const imageLabel = answer.imageCount ? formatAttachedImages(answer.imageCount) : undefined;
		const imageSuffix = imageLabel && answer.label !== imageLabel ? `; ${imageLabel}` : "";
		return `${answer.label} (custom answer${imageSuffix})`;
	}
	return `${answer.label} (choice ${answer.index})`;
}

export function createQuestionToolResult(details: QuestionResultDetails, questions: NormalizedQuestion[] = [], images: QuestionImageContent[] = []): QuestionToolResult {
	return {
		content: [
			{
				type: "text",
				text: summarizeQuestionResult(details, questions),
			},
			...images.map((image) => ({ ...image })),
		],
		details,
	};
}
