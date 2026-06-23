import type { ToolRendererMiddleware } from "./types.js";
import { argsRecord, expandedTextFromParts, renderWithArgsAndResult } from "./utils.js";

type QuestionChoice = {
	value?: unknown;
	label?: unknown;
	description?: unknown;
};

type QuestionItem = {
	id?: unknown;
	label?: unknown;
	prompt?: unknown;
	choices?: unknown;
};

type QuestionAnswer = {
	id?: unknown;
	label?: unknown;
	wasCustom?: unknown;
	index?: unknown;
};

type QuestionDetails = {
	canceled?: unknown;
	reason?: unknown;
	fallbackPrompt?: unknown;
	answers?: unknown;
};

const CUSTOM_ANSWER_LABEL = "Something else…";

export const renderQuestionTool: ToolRendererMiddleware = (input) => {
	const args = argsRecord(input);
	const questions = questionItems(args?.questions);
	const count = questions?.length;
	if (!questions) {
		return renderWithArgsAndResult(input, {
			headerArgs: count != null ? `${count} question${count === 1 ? "" : "s"}` : undefined,
			collapsedBody: input.output,
		});
	}

	const resultText = formatQuestionResult(input.details, questions)
		?? (input.output.trim() || (input.status === "running" ? "waiting for answers…" : "(empty)"));
	const questionsText = formatQuestions(questions);
	return {
		headerArgs: formatHeader(questions),
		collapsedBody: resultText,
		...expandedTextFromParts(
			{ text: questionsText },
			{ text: input.isError ? `error\n${resultText}` : resultText },
		),
	};
};

function questionItems(value: unknown): QuestionItem[] | undefined {
	if (!Array.isArray(value)) return undefined;
	return value.filter(isPlainRecord);
}

function formatHeader(questions: readonly QuestionItem[]): string {
	const labels = questions
		.map((question) => stringValue(question.label) ?? stringValue(question.id))
		.filter((label): label is string => label !== undefined);
	const countText = `${questions.length} question${questions.length === 1 ? "" : "s"}`;
	if (labels.length === 0) return countText;

	const suffix = labels.length > 3 ? ", …" : "";
	return `${countText} · ${labels.slice(0, 3).join(", ")}${suffix}`;
}

function formatQuestions(questions: readonly QuestionItem[]): string {
	return questions.map((question, index) => {
		const title = `◇ ${index + 1}/${questions.length} ${questionLabel(question)}`;
		const prompt = stringValue(question.prompt) ?? "(no prompt)";
		const choices = Array.isArray(question.choices)
			? question.choices.filter(isPlainRecord) as QuestionChoice[]
			: [];
		const choiceLines = choices.map((choice, choiceIndex) => {
			const label = stringValue(choice.label) ?? stringValue(choice.value) ?? `Choice ${choiceIndex + 1}`;
			const description = stringValue(choice.description);
			return description ? `  ${choiceIndex + 1}. ${label} — ${description}` : `  ${choiceIndex + 1}. ${label}`;
		});
		choiceLines.push(`  ${choices.length + 1}. ${CUSTOM_ANSWER_LABEL} (custom answer)`);
		return [title, `  ${prompt}`, ...choiceLines].join("\n");
	}).join("\n\n");
}

function formatQuestionResult(details: unknown, questions: readonly QuestionItem[]): string | undefined {
	if (!isPlainRecord(details)) return undefined;
	const questionLabels = new Map(questions.map((question) => [stringValue(question.id), questionLabel(question)]));
	const questionDetails = details as QuestionDetails;
	if (questionDetails.canceled === true) {
		const reason = stringValue(questionDetails.reason) ?? "canceled";
		const fallback = stringValue(questionDetails.fallbackPrompt);
		return fallback ? `⚠ canceled: ${reason}\n\n${fallback}` : `⚠ canceled: ${reason}`;
	}

	if (!Array.isArray(questionDetails.answers)) return undefined;
	if (questionDetails.answers.length === 0) return "question returned no answers";
	return questionDetails.answers
		.filter(isPlainRecord)
		.map((answer) => formatAnswer(answer as QuestionAnswer, questionLabels))
		.join("\n");
}

function formatAnswer(answer: QuestionAnswer, questionLabels: ReadonlyMap<string | undefined, string>): string {
	const label = questionLabels.get(stringValue(answer.id)) ?? stringValue(answer.id) ?? "Question";
	const answerLabel = stringValue(answer.label) ?? "(empty)";
	if (answer.wasCustom === true) return `✓ ${label}: ${answerLabel} (custom answer)`;
	const index = typeof answer.index === "number" && Number.isFinite(answer.index) ? `choice ${answer.index}` : "choice";
	return `✓ ${label}: ${answerLabel} (${index})`;
}

function questionLabel(question: QuestionItem): string {
	return stringValue(question.label) ?? stringValue(question.id) ?? "Question";
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
