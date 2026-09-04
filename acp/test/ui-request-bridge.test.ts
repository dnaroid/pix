import assert from "node:assert/strict";
import { test } from "node:test";
import type { CreateElicitationRequest, ElicitationSchema } from "@agentclientprotocol/sdk";
import type { RpcExtensionUIRequest } from "@earendil-works/pi-coding-agent";
import {
	cancelledResponse,
	fromElicitationResponse,
	PIX_QUESTION_EDITOR_TITLE,
	PIX_QUESTION_ELICITATION_MODE,
	toElicitationRequest,
} from "../src/acp/ui-request-bridge.js";

const OPTIONS = { sessionId: "session-1", elicitationId: "el-1" };

/**
 * The union's open `mode: string` variant defeats `in`-narrowing, so assert
 * form mode and cast to the form payload's schema.
 */
function formSchema(elicitation: CreateElicitationRequest | undefined): ElicitationSchema {
	assert.ok(elicitation !== undefined);
	assert.equal(elicitation.mode, "form");
	return (elicitation as { requestedSchema: ElicitationSchema }).requestedSchema;
}

test("select maps to a form elicitation with an enum property", () => {
	const request: RpcExtensionUIRequest = {
		type: "extension_ui_request",
		id: "ui-1",
		method: "select",
		title: "Allow dangerous command?",
		options: ["Allow", "Block"],
		timeout: 10_000,
	};
	const elicitation = toElicitationRequest(request, OPTIONS);
	assert.deepEqual(elicitation, {
		mode: "form",
		elicitationId: "el-1",
		sessionId: "session-1",
		message: "Allow dangerous command?",
		requestedSchema: {
			type: "object",
			title: "Allow dangerous command?",
			properties: {
				value: { type: "string", title: "Allow dangerous command?", enum: ["Allow", "Block"] },
			},
			required: ["value"],
		},
	} satisfies CreateElicitationRequest);
});

test("confirm maps to a boolean property and folds the message body in", () => {
	const elicitation = toElicitationRequest(
		{ type: "extension_ui_request", id: "ui-2", method: "confirm", title: "Clear session?", message: "All messages will be lost." },
		OPTIONS,
	);
	assert.equal(elicitation?.message, "Clear session?\n\nAll messages will be lost.");
	assert.deepEqual(formSchema(elicitation).properties?.value, { type: "boolean", title: "Clear session?" });
	assert.deepEqual(formSchema(elicitation)?.required, ["value"]);
});

test("input maps to a string property with the placeholder as description", () => {
	const elicitation = toElicitationRequest(
		{ type: "extension_ui_request", id: "ui-3", method: "input", title: "Enter a value", placeholder: "type something..." },
		OPTIONS,
	);
	assert.deepEqual(formSchema(elicitation).properties?.value, {
		type: "string",
		title: "Enter a value",
		description: "type something...",
	});
});

test("editor maps to a string property with the prefill as default", () => {
	const withPrefill = toElicitationRequest(
		{ type: "extension_ui_request", id: "ui-4", method: "editor", title: "Edit text", prefill: "Line 1" },
		OPTIONS,
	);
	assert.deepEqual(formSchema(withPrefill).properties?.value, {
		type: "string",
		title: "Edit text",
		default: "Line 1",
	});

	const emptyPrefill = toElicitationRequest(
		{ type: "extension_ui_request", id: "ui-5", method: "editor", title: "Edit text", prefill: "" },
		OPTIONS,
	);
	assert.equal("default" in (formSchema(emptyPrefill).properties?.value ?? {}), false);
});

test("reserved question editor carrier maps to a private structured elicitation", () => {
	const request: RpcExtensionUIRequest = {
		type: "extension_ui_request",
		id: "question-1",
		method: "editor",
		title: PIX_QUESTION_EDITOR_TITLE,
		prefill: JSON.stringify({
			version: 1,
			questions: [{
				id: "scope",
				label: " Scope ",
				prompt: " Which scope? ",
				choices: [
					{ value: "small", label: "Small", description: "Quick change" },
					{ value: "large", label: "Large", description: "" },
				],
			}],
		}),
	};
	assert.deepEqual(toElicitationRequest(request, OPTIONS), {
		mode: PIX_QUESTION_ELICITATION_MODE,
		elicitationId: "el-1",
		sessionId: "session-1",
		message: "Answer the agent's question",
		version: 1,
		questions: [{
			id: "scope",
			label: "Scope",
			prompt: "Which scope?",
			choices: [
				{ value: "small", label: "Small", description: "Quick change" },
				{ value: "large", label: "Large", description: "" },
			],
		}],
	});
	assert.deepEqual(
		fromElicitationResponse({ action: "accept", content: { value: "{\"version\":1}" } }, request),
		{ type: "extension_ui_response", id: "question-1", value: "{\"version\":1}" },
	);
});

test("reserved question carrier preserves normalized multi-select bounds", () => {
	const request: RpcExtensionUIRequest = {
		type: "extension_ui_request",
		id: "question-multiple",
		method: "editor",
		title: PIX_QUESTION_EDITOR_TITLE,
		prefill: JSON.stringify({
			version: 1,
			questions: [{
				id: "areas",
				label: "Areas",
				prompt: "Which areas?",
				choices: [{ value: "api", label: "API" }, { value: "ui", label: "UI" }],
				multiple: true,
				minSelections: 2,
				maxSelections: 3,
			}],
		}),
	};
	const elicitation = toElicitationRequest(request, OPTIONS) as unknown as Record<string, unknown>;
	assert.deepEqual(elicitation.questions, [{
		id: "areas",
		label: "Areas",
		prompt: "Which areas?",
		choices: [{ value: "api", label: "API" }, { value: "ui", label: "UI" }],
		multiple: true,
		minSelections: 2,
		maxSelections: 3,
	}]);
});

test("malformed reserved question carriers are rejected instead of shown as editors", () => {
	const malformed = (prefill: string): RpcExtensionUIRequest => ({
		type: "extension_ui_request",
		id: "question-bad",
		method: "editor",
		title: PIX_QUESTION_EDITOR_TITLE,
		prefill,
	});
	assert.equal(toElicitationRequest(malformed("not json"), OPTIONS), undefined);
	assert.equal(toElicitationRequest(malformed(JSON.stringify({ version: 2, questions: [] })), OPTIONS), undefined);
	assert.equal(toElicitationRequest(malformed(JSON.stringify({
		version: 1,
		questions: [{
			id: "Scope",
			label: "Scope",
			prompt: "Choose",
			choices: [{ value: "same", label: "One" }, { value: "SAME", label: "Two" }],
		}],
	})), OPTIONS), undefined);
	assert.equal(toElicitationRequest(malformed(JSON.stringify({
		version: 1,
		questions: [{
			id: "areas",
			label: "Areas",
			prompt: "Choose",
			choices: [{ value: "api", label: "API" }, { value: "ui", label: "UI" }],
			multiple: true,
			minSelections: 3,
			maxSelections: 2,
		}],
	})), OPTIONS), undefined);
});

test("fire-and-forget UI requests have no elicitation mapping", () => {
	const requests: RpcExtensionUIRequest[] = [
		{ type: "extension_ui_request", id: "a", method: "notify", message: "hi", notifyType: "warning" },
		{ type: "extension_ui_request", id: "b", method: "setStatus", statusKey: "k", statusText: "t" },
		{ type: "extension_ui_request", id: "c", method: "setWidget", widgetKey: "k", widgetLines: ["l"] },
		{ type: "extension_ui_request", id: "d", method: "setTitle", title: "t" },
		{ type: "extension_ui_request", id: "e", method: "set_editor_text", text: "t" },
	];
	for (const request of requests) {
		assert.equal(toElicitationRequest(request, OPTIONS), undefined, request.method);
	}
});

test("accept answers map back to extension_ui_response values", () => {
	const select: RpcExtensionUIRequest = {
		type: "extension_ui_request",
		id: "ui-1",
		method: "select",
		title: "Pick",
		options: ["Allow", "Block"],
	};
	assert.deepEqual(fromElicitationResponse({ action: "accept", content: { value: "Allow" } }, select), {
		type: "extension_ui_response",
		id: "ui-1",
		value: "Allow",
	});

	const confirm: RpcExtensionUIRequest = {
		type: "extension_ui_request",
		id: "ui-2",
		method: "confirm",
		title: "Sure?",
		message: "m",
	};
	assert.deepEqual(fromElicitationResponse({ action: "accept", content: { value: true } }, confirm), {
		type: "extension_ui_response",
		id: "ui-2",
		confirmed: true,
	});
	assert.deepEqual(fromElicitationResponse({ action: "accept", content: { value: false } }, confirm), {
		type: "extension_ui_response",
		id: "ui-2",
		confirmed: false,
	});

	const input: RpcExtensionUIRequest = {
		type: "extension_ui_request",
		id: "ui-3",
		method: "input",
		title: "Name",
	};
	assert.deepEqual(fromElicitationResponse({ action: "accept", content: { value: "" } }, input), {
		type: "extension_ui_response",
		id: "ui-3",
		value: "",
	});
});

test("decline, cancel, malformed, and mismatched answers map to cancelled", () => {
	const select: RpcExtensionUIRequest = {
		type: "extension_ui_request",
		id: "ui-1",
		method: "select",
		title: "Pick",
		options: ["Allow", "Block"],
	};
	assert.deepEqual(fromElicitationResponse({ action: "decline" }, select), cancelledResponse("ui-1"));
	assert.deepEqual(fromElicitationResponse({ action: "cancel" }, select), cancelledResponse("ui-1"));
	// Number where a string is expected.
	assert.deepEqual(fromElicitationResponse({ action: "accept", content: { value: 3 } }, select), cancelledResponse("ui-1"));
	// Accept without any content.
	assert.deepEqual(fromElicitationResponse({ action: "accept" }, select), cancelledResponse("ui-1"));

	const confirm: RpcExtensionUIRequest = {
		type: "extension_ui_request",
		id: "ui-2",
		method: "confirm",
		title: "Sure?",
		message: "m",
	};
	assert.deepEqual(fromElicitationResponse({ action: "accept", content: { value: "yes" } }, confirm), cancelledResponse("ui-2"));
});
