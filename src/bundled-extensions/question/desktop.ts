import type {
	NormalizedQuestion,
	QuestionImageContent,
	QuestionSelection,
	QuestionUiContext,
} from "./types.js";

export const PIX_QUESTION_RPC_ENV = "PIX_QUESTION_RPC_BRIDGE";
export const PIX_QUESTION_EDITOR_TITLE = "__pix_question_v1__";
export const PIX_QUESTION_PROTOCOL_VERSION = 1;
export const MAX_DESKTOP_QUESTION_IMAGES = 10;
export const MAX_DESKTOP_QUESTION_IMAGE_BYTES = 25 * 1024 * 1024;
export const MAX_DESKTOP_QUESTION_IMAGE_BYTES_TOTAL = 50 * 1024 * 1024;

interface DesktopQuestionResponse {
	version: typeof PIX_QUESTION_PROTOCOL_VERSION;
	selections: QuestionSelection[];
}

export function shouldUseDesktopQuestionBridge(
	ctx: QuestionUiContext,
	environment: NodeJS.ProcessEnv = process.env,
): boolean {
	return environment[PIX_QUESTION_RPC_ENV] === "1" && typeof ctx.ui.editor === "function";
}

export async function runDesktopQuestionnaire(
	questions: NormalizedQuestion[],
	ctx: QuestionUiContext,
): Promise<QuestionSelection[] | null> {
	const answer = await ctx.ui.editor?.(
		PIX_QUESTION_EDITOR_TITLE,
		JSON.stringify({ version: PIX_QUESTION_PROTOCOL_VERSION, questions }),
	);
	if (answer === undefined) return null;
	return parseDesktopQuestionResponse(answer, questions);
}

export function parseDesktopQuestionResponse(
	value: string,
	questions: NormalizedQuestion[],
): QuestionSelection[] | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(value);
	} catch {
		return null;
	}
	if (!isRecord(parsed) || parsed.version !== PIX_QUESTION_PROTOCOL_VERSION || !Array.isArray(parsed.selections)) {
		return null;
	}
	if (parsed.selections.length !== questions.length) return null;

	const questionById = new Map(questions.map((question) => [question.id, question]));
	const seenIds = new Set<string>();
	const selections: QuestionSelection[] = [];
	let imageCount = 0;
	let imageBytes = 0;

	for (const rawSelection of parsed.selections) {
		if (!isRecord(rawSelection) || typeof rawSelection.id !== "string") return null;
		const question = questionById.get(rawSelection.id);
		if (!question || seenIds.has(rawSelection.id)) return null;
		seenIds.add(rawSelection.id);

		if (question.multiple) {
			if (Object.keys(rawSelection).some((key) => !["id", "choiceValues", "customText", "images"].includes(key))) return null;
			if (!Array.isArray(rawSelection.choiceValues) || rawSelection.choiceValues.some((choice) => typeof choice !== "string")) return null;
			const selectedValues = new Set(rawSelection.choiceValues as string[]);
			if (selectedValues.size !== rawSelection.choiceValues.length) return null;
			if ([...selectedValues].some((value) => !question.choices.some((choice) => choice.value === value))) return null;
			if (rawSelection.customText !== undefined && typeof rawSelection.customText !== "string") return null;
			if (rawSelection.images !== undefined && (rawSelection.customText === undefined || !Array.isArray(rawSelection.images))) return null;
			const images: QuestionImageContent[] = [];
			for (const rawImage of rawSelection.images ?? []) {
				const image = parseImage(rawImage);
				if (!image) return null;
				const bytes = decodedBase64Size(image.data);
				imageCount += 1;
				imageBytes += bytes;
				if (
					imageCount > MAX_DESKTOP_QUESTION_IMAGES
					|| bytes > MAX_DESKTOP_QUESTION_IMAGE_BYTES
					|| imageBytes > MAX_DESKTOP_QUESTION_IMAGE_BYTES_TOTAL
				) return null;
				images.push(image);
			}
			const hasCustom = rawSelection.customText !== undefined;
			if (hasCustom && !(rawSelection.customText as string).trim() && images.length === 0) return null;
			const selectionCount = selectedValues.size + (hasCustom ? 1 : 0);
			if (selectionCount < (question.minSelections ?? 1) || selectionCount > (question.maxSelections ?? question.choices.length + 1)) return null;
			selections.push({
				id: rawSelection.id,
				choiceValues: question.choices.filter((choice) => selectedValues.has(choice.value)).map((choice) => choice.value),
				...(hasCustom ? { customText: rawSelection.customText as string } : {}),
				...(images.length > 0 ? { images } : {}),
			});
			continue;
		}

		if (typeof rawSelection.choiceValue === "string") {
			if (Object.keys(rawSelection).some((key) => !["id", "choiceValue"].includes(key))) return null;
			if (!question.choices.some((choice) => choice.value === rawSelection.choiceValue)) return null;
			selections.push({ id: rawSelection.id, choiceValue: rawSelection.choiceValue });
			continue;
		}

		if (typeof rawSelection.customText !== "string") return null;
		if (Object.keys(rawSelection).some((key) => !["id", "customText", "images"].includes(key))) return null;
		if (rawSelection.images !== undefined && !Array.isArray(rawSelection.images)) return null;
		const images: QuestionImageContent[] = [];
		for (const rawImage of rawSelection.images ?? []) {
			const image = parseImage(rawImage);
			if (!image) return null;
			const bytes = decodedBase64Size(image.data);
			imageCount += 1;
			imageBytes += bytes;
			if (
				imageCount > MAX_DESKTOP_QUESTION_IMAGES
				|| bytes > MAX_DESKTOP_QUESTION_IMAGE_BYTES
				|| imageBytes > MAX_DESKTOP_QUESTION_IMAGE_BYTES_TOTAL
			) return null;
			images.push(image);
		}
		if (!rawSelection.customText.trim() && images.length === 0) return null;
		selections.push({
			id: rawSelection.id,
			customText: rawSelection.customText,
			...(images.length > 0 ? { images } : {}),
		});
	}

	return selections;
}

export function createDesktopQuestionResponse(selections: QuestionSelection[]): string {
	const response: DesktopQuestionResponse = { version: PIX_QUESTION_PROTOCOL_VERSION, selections };
	return JSON.stringify(response);
}

function parseImage(value: unknown): QuestionImageContent | null {
	if (!isRecord(value) || Object.keys(value).some((key) => !["type", "data", "mimeType"].includes(key))) return null;
	if (value.type !== "image" || typeof value.data !== "string" || typeof value.mimeType !== "string") return null;
	if (!/^image\/[a-z0-9.+-]+$/i.test(value.mimeType) || !isBase64(value.data)) return null;
	return { type: "image", data: value.data, mimeType: value.mimeType };
}

function isBase64(value: string): boolean {
	return value.length > 0 && value.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(value);
}

function decodedBase64Size(value: string): number {
	const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
	return (value.length / 4) * 3 - padding;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
