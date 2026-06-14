import { Type } from "typebox";

import type { NormalizedQuestion, QuestionToolInput } from "./types.js";

export const CUSTOM_ANSWER_LABEL = "Something else…";
export const CUSTOM_ANSWER_SENTINEL_VALUE = "__question_custom_answer__";
export const MIN_QUESTIONS = 1;
export const MAX_QUESTIONS = 5;
export const MIN_CHOICES = 2;
export const MAX_CHOICES = 5;
export const QUESTION_ID_PATTERN = /^[a-z][a-z0-9_-]*$/;

export const questionParameters = Type.Object({
	questions: Type.Array(Type.Object({
		id: Type.String({ description: "Unique stable question id." }),
		label: Type.String({ description: "Short label for the question." }),
		prompt: Type.String({ description: "Full question prompt to show the user." }),
		choices: Type.Array(Type.Object({
			value: Type.String({ description: "Value returned if this choice is selected." }),
			label: Type.String({ description: "Display label for this choice." }),
			description: Type.Optional(Type.String({ description: "Optional supporting text for this choice." })),
		}), {
			minItems: MIN_CHOICES,
			maxItems: MAX_CHOICES,
			description: "Two to five meaningful predefined choices.",
		}),
	}), {
		minItems: MIN_QUESTIONS,
		maxItems: MAX_QUESTIONS,
		description: "One to five questions to ask the user.",
	}),
});

export function normalizeQuestionInput(input: QuestionToolInput): NormalizedQuestion[] {
	const questions = input.questions;
	if (!Array.isArray(questions) || questions.length < MIN_QUESTIONS || questions.length > MAX_QUESTIONS) {
		throwInvalid(`question requires ${MIN_QUESTIONS} to ${MAX_QUESTIONS} questions; received ${Array.isArray(questions) ? questions.length : "no"}.`, "Retry with a questions array containing one to five questions.");
	}

	const seenQuestionIds = new Set<string>();
	const seenQuestionLabels = new Set<string>();
	return questions.map((question, questionIndex) => {
		const questionNumber = questionIndex + 1;
		const id = trimString(question.id, `question ${questionNumber} id`);
		const label = trimString(question.label, `question ${questionNumber} label`);
		const prompt = trimString(question.prompt, `question ${questionNumber} prompt`);
		if (!QUESTION_ID_PATTERN.test(id)) throwInvalid(`Question ${questionNumber} has invalid id "${id}". IDs must match ${QUESTION_ID_PATTERN.source}.`, "Retry with a stable id starting with a lowercase letter and containing only lowercase letters, numbers, underscores, or hyphens.");
		if (seenQuestionIds.has(id)) throwInvalid(`Duplicate question id "${id}" makes question answers ambiguous.`, "Retry with a unique stable id for each question.");
		seenQuestionIds.add(id);

		const normalizedLabel = normalizeForUniqueness(label);
		if (seenQuestionLabels.has(normalizedLabel)) throwInvalid(`Duplicate question label "${label}" makes question summaries ambiguous.`, "Retry with a unique short label for each question; labels are compared case-insensitively.");
		seenQuestionLabels.add(normalizedLabel);
		if (label.includes("\n") || label.includes("\r")) throwInvalid(`Question ${questionNumber} label must be single-line.`, "Retry with a short single-line label and put longer text in the prompt.");

		if (!Array.isArray(question.choices) || question.choices.length < MIN_CHOICES || question.choices.length > MAX_CHOICES) {
			throwInvalid(`Question "${id}" requires ${MIN_CHOICES} to ${MAX_CHOICES} predefined Choices; received ${Array.isArray(question.choices) ? question.choices.length : "no"}.`, "Retry with two to five meaningful predefined Choices for each question.");
		}

		const seenChoiceValues = new Set<string>();
		const seenChoiceLabels = new Set<string>();
		return {
			id,
			label,
			prompt,
			choices: question.choices.map((choice, choiceIndex) => {
				const choiceNumber = choiceIndex + 1;
				const value = trimString(choice.value, `question "${id}" Choice ${choiceNumber} value`);
				const choiceLabel = trimString(choice.label, `question "${id}" Choice ${choiceNumber} label`);
				const description = choice.description === undefined ? undefined : choice.description.trim();
				if (value === CUSTOM_ANSWER_SENTINEL_VALUE) throwInvalid(`Question "${id}" Choice ${choiceNumber} uses the reserved Custom Answer sentinel value "${CUSTOM_ANSWER_SENTINEL_VALUE}".`, "Retry with a different Choice value; ordinary values like other or custom are allowed.");

				const normalizedValue = normalizeForUniqueness(value);
				if (seenChoiceValues.has(normalizedValue)) throwInvalid(`Question "${id}" has duplicate Choice value "${value}".`, "Retry with unique Choice values within each question; values are compared case-insensitively.");
				seenChoiceValues.add(normalizedValue);

				const normalizedChoiceLabel = normalizeForUniqueness(choiceLabel);
				if (seenChoiceLabels.has(normalizedChoiceLabel)) throwInvalid(`Question "${id}" has duplicate Choice label "${choiceLabel}".`, "Retry with unique visible Choice labels within each question; labels are compared case-insensitively.");
				seenChoiceLabels.add(normalizedChoiceLabel);
				if (normalizedChoiceLabel === normalizeForUniqueness(CUSTOM_ANSWER_LABEL)) throwInvalid(`Question "${id}" Choice label "${choiceLabel}" collides with the implicit Custom Answer row label "${CUSTOM_ANSWER_LABEL}".`, "Retry with a different predefined Choice label; the Custom Answer row is added automatically.");

				return description === undefined ? { value, label: choiceLabel } : { value, label: choiceLabel, description };
			}),
		};
	});
}

export function trimString(value: string, field: string): string {
	const trimmed = value.trim();
	if (!trimmed) throwInvalid(`${field} must not be empty after trimming.`, "Retry with non-empty text for every required question field.");
	return trimmed;
}

export function normalizeForUniqueness(value: string): string {
	return value.toLocaleLowerCase();
}

export function throwInvalid(problem: string, repair: string): never {
	throw new Error(`Invalid question input: ${problem} ${repair}`);
}
