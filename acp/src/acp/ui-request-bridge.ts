/**
 * Bridge between pi extension UI requests and ACP elicitations.
 *
 * pi extensions ask the user questions through `ctx.ui.select()/confirm()/
 * input()/editor()`. In RPC mode these arrive as `extension_ui_request`
 * events and block the extension until an `extension_ui_response` is written
 * back. ACP's equivalent surface is `elicitation/create` (form mode), which
 * clients such as Zed render as a form next to the conversation.
 *
 * Fire-and-forget pi methods (`notify`, `setStatus`, `setWidget`, `setTitle`,
 * `set_editor_text`) have no ACP counterpart and are ignored by this bridge.
 */

import type {
	CreateElicitationRequest,
	CreateElicitationResponse,
	ElicitationPropertySchema,
	ElicitationSchema,
} from "@agentclientprotocol/sdk";
import type { RpcExtensionUIRequest, RpcExtensionUIResponse } from "@earendil-works/pi-coding-agent";

/** Property name used for the single form field in every mapping. */
const FIELD = "value";
export const PIX_QUESTION_EDITOR_TITLE = "__pix_question_v1__";
export const PIX_QUESTION_ELICITATION_MODE = "_pix.question";

export interface PixQuestionChoice {
	readonly value: string;
	readonly label: string;
	readonly description?: string;
}

export interface PixQuestion {
	readonly id: string;
	readonly label: string;
	readonly prompt: string;
	readonly choices: PixQuestionChoice[];
	readonly multiple?: true;
	readonly minSelections?: number;
	readonly maxSelections?: number;
}

export interface ElicitationRequestOptions {
	readonly sessionId: string;
	readonly elicitationId: string;
}

/**
 * Maps a pi dialog request to an ACP form elicitation.
 * Returns `undefined` for fire-and-forget requests that need no answer.
 */
export function toElicitationRequest(
	request: RpcExtensionUIRequest,
	options: ElicitationRequestOptions,
): CreateElicitationRequest | undefined {
	if (request.method === "editor" && request.title === PIX_QUESTION_EDITOR_TITLE) {
		const questions = parseQuestionCarrier(request.prefill);
		if (!questions) return undefined;
		return {
			mode: PIX_QUESTION_ELICITATION_MODE,
			elicitationId: options.elicitationId,
			sessionId: options.sessionId,
			message: questions.length === 1 ? "Answer the agent's question" : "Answer the agent's questions",
			version: 1,
			questions,
		} as CreateElicitationRequest;
	}
	switch (request.method) {
		case "select":
			return formElicitation(request, options, {
				type: "string",
				title: request.title,
				enum: [...request.options],
			});
		case "confirm":
			return formElicitation(request, options, { type: "boolean", title: request.title });
		case "input":
			return formElicitation(request, options, {
				type: "string",
				title: request.title,
				...(request.placeholder ? { description: request.placeholder } : {}),
			});
		case "editor":
			return formElicitation(request, options, {
				type: "string",
				title: request.title,
				...(request.prefill !== undefined && request.prefill !== "" ? { default: request.prefill } : {}),
			});
		default:
			return undefined;
	}
}

function parseQuestionCarrier(prefill: string | undefined): PixQuestion[] | null {
	if (prefill === undefined) return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(prefill);
	} catch {
		return null;
	}
	if (!isRecord(parsed) || parsed.version !== 1 || !Array.isArray(parsed.questions)) return null;
	if (parsed.questions.length < 1 || parsed.questions.length > 5) return null;

	const ids = new Set<string>();
	const labels = new Set<string>();
	const questions: PixQuestion[] = [];
	for (const rawQuestion of parsed.questions) {
		if (!isRecord(rawQuestion) || !hasOnlyKeys(rawQuestion, ["id", "label", "prompt", "choices", "multiple", "minSelections", "maxSelections"])) return null;
		const id = trimmedString(rawQuestion.id);
		const label = trimmedString(rawQuestion.label);
		const prompt = trimmedString(rawQuestion.prompt);
		if (!id || !label || !prompt || !/^[a-z][a-z0-9_-]*$/.test(id) || /[\r\n]/.test(label)) return null;
		const normalizedLabel = label.toLocaleLowerCase();
		if (ids.has(id) || labels.has(normalizedLabel) || !Array.isArray(rawQuestion.choices)) return null;
		if (rawQuestion.choices.length < 2 || rawQuestion.choices.length > 5) return null;
		ids.add(id);
		labels.add(normalizedLabel);

		const values = new Set<string>();
		const choiceLabels = new Set<string>();
		const choices: PixQuestionChoice[] = [];
		for (const rawChoice of rawQuestion.choices) {
			if (!isRecord(rawChoice) || !hasOnlyKeys(rawChoice, ["value", "label", "description"])) return null;
			const value = trimmedString(rawChoice.value);
			const choiceLabel = trimmedString(rawChoice.label);
			const description = rawChoice.description === undefined
				? undefined
				: typeof rawChoice.description === "string" ? rawChoice.description : null;
			const normalizedValue = value?.toLocaleLowerCase();
			const normalizedChoiceLabel = choiceLabel?.toLocaleLowerCase();
			if (
				!value || !choiceLabel || description === null
				|| value === "__question_custom_answer__"
				|| normalizedChoiceLabel === "something else…"
				|| values.has(normalizedValue!) || choiceLabels.has(normalizedChoiceLabel!)
			) return null;
			values.add(normalizedValue!);
			choiceLabels.add(normalizedChoiceLabel!);
			choices.push({ value, label: choiceLabel, ...(description !== undefined ? { description } : {}) });
		}
		const multiple = rawQuestion.multiple === true;
		if (rawQuestion.multiple !== undefined && !multiple) return null;
		if (!multiple && (rawQuestion.minSelections !== undefined || rawQuestion.maxSelections !== undefined)) return null;
		const minSelections = positiveInteger(rawQuestion.minSelections);
		const maxSelections = positiveInteger(rawQuestion.maxSelections);
		if (multiple && (
			minSelections === null || maxSelections === null
			|| minSelections > maxSelections || maxSelections > choices.length + 1
		)) return null;
		questions.push({
			id,
			label,
			prompt,
			choices,
			...(multiple ? { multiple: true, minSelections: minSelections!, maxSelections: maxSelections! } : {}),
		});
	}
	return questions;
}

function positiveInteger(value: unknown): number | null {
	return typeof value === "number" && Number.isInteger(value) && value >= 1 ? value : null;
}

function trimmedString(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	return trimmed || null;
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
	return Object.keys(value).every((key) => keys.includes(key));
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Maps the client's elicitation answer back to a pi `extension_ui_response`. */
export function fromElicitationResponse(
	response: CreateElicitationResponse,
	request: RpcExtensionUIRequest,
): RpcExtensionUIResponse {
	if (response.action !== "accept") {
		return cancelledResponse(request.id);
	}
	// `content` exists only on the accept variant; the open action variant
	// keeps it `unknown`, so read it defensively.
	const content = (response as { content?: { [key: string]: unknown } | null }).content;
	const value = content?.[FIELD];
	switch (request.method) {
		case "select":
			return typeof value === "string" ? { type: "extension_ui_response", id: request.id, value } : cancelledResponse(request.id);
		case "confirm":
			return typeof value === "boolean"
				? { type: "extension_ui_response", id: request.id, confirmed: value }
				: cancelledResponse(request.id);
		case "input":
		case "editor":
			return typeof value === "string" ? { type: "extension_ui_response", id: request.id, value } : cancelledResponse(request.id);
		default:
			return cancelledResponse(request.id);
	}
}

export function cancelledResponse(id: string): RpcExtensionUIResponse {
	return { type: "extension_ui_response", id, cancelled: true };
}

function formElicitation(
	request: RpcExtensionUIRequest & { title: string; method: string },
	options: ElicitationRequestOptions,
	property: ElicitationPropertySchema,
): CreateElicitationRequest {
	const schema: ElicitationSchema = {
		type: "object",
		title: request.title,
		properties: { [FIELD]: property },
		required: [FIELD],
	};
	const message =
		request.method === "confirm" && "message" in request && request.message
			? `${request.title}\n\n${request.message}`
			: request.title;
	return {
		mode: "form",
		elicitationId: options.elicitationId,
		sessionId: options.sessionId,
		message,
		requestedSchema: schema,
	};
}
