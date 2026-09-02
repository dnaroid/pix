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
