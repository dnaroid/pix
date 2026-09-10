import { RequestError, type ContentBlock, type SessionUpdate } from "@agentclientprotocol/sdk";

const ERROR_INVALID_PARAMS = -32602;

export const PIX_FORK_MESSAGES_METHOD = "pix/session/fork_messages";
export const PIX_ENHANCE_PROMPT_METHOD = "pix/prompt/enhance";
export const PIX_IMPORT_SESSION_METHOD = "pix/session/import";
export const PIX_RELOAD_SESSION_METHOD = "pix/session/reload";
export const PIX_REQUEST_HISTORY_METHOD = "pix/request-history";
export const PIX_RESUME_PATH_METHOD = "pix/session/resume_path";
export const PIX_SESSION_HISTORY_METHOD = "pix/session/history";
export const PIX_TOOL_RESULT_METHOD = "pix/session/tool_result";
export const PIX_SESSION_IMAGE_METHOD = "pix/session/image";
export const PIX_QUEUE_STATE_METHOD = "pix/session/queue_state";
export const PIX_QUEUE_MESSAGE_METHOD = "pix/session/queue_message";
export const PIX_DEFER_MESSAGE_METHOD = "pix/session/defer_message";
export const PIX_QUEUE_ACTION_METHOD = "pix/session/queue_action";
export const PIX_TAKE_AUTO_MESSAGE_METHOD = "pix/session/take_auto_message";
export const PIX_QUEUE_CONSUMED_METHOD = "pix/session/queue_consumed";
export const PIX_REGISTRY_ACTION_METHOD = "pix/registry/action";
export const PIX_GIT_ASSIST_METHOD = "pix/git/assist";
export const PIX_BRANCH_USER_MESSAGES_METHOD = "pix/session/branch_user_messages";
export const PIX_USER_MESSAGE_ACTION_METHOD = "pix/session/user_message_action";

export interface DesktopSessionRequest {
	readonly sessionId: string;
}

export interface DesktopSessionHistoryRequest extends DesktopSessionRequest {
	readonly full?: boolean;
}

export interface DesktopResumePathRequest extends DesktopSessionRequest {
	readonly path: string;
}

export interface DesktopEnhancePromptRequest extends DesktopSessionRequest {
	readonly draft: string;
}

export interface DesktopEnhancePromptResponse {
	readonly prompt: string;
}

export type DesktopGitAssistantKind = "review" | "commit-message";

export interface DesktopGitAssistantRequest extends DesktopSessionRequest {
	readonly kind: DesktopGitAssistantKind;
	readonly diff: string;
}

export interface DesktopGitAssistantResponse {
	readonly text: string;
}

export interface DesktopImportSessionRequest extends DesktopSessionRequest {
	readonly path: string;
}

export interface DesktopRequestHistoryResponse {
	readonly entries: readonly string[];
}

export interface ForkMessage {
	readonly entryId: string;
	readonly text: string;
}

export interface ForkMessagesResponse {
	readonly messages: readonly ForkMessage[];
}

export type DesktopUserMessageAction = "copy" | "undo";

export interface DesktopUserMessageActionRequest extends DesktopSessionRequest {
	readonly entryId: string;
	readonly action: DesktopUserMessageAction;
}

export interface DesktopUserMessageActionResponse {
	readonly status: "ok" | "warning" | "cancelled";
	readonly editorText?: string;
	readonly revertedChanges?: number;
	readonly changedFiles?: number;
	readonly warning?: string;
}

export interface DesktopSessionHistoryResponse {
	readonly updates: readonly SessionUpdate[];
	readonly deferredToolCallIds: readonly string[];
}

export interface DesktopToolResultRequest extends DesktopSessionRequest {
	readonly toolCallId: string;
}

export interface DesktopToolResultResponse {
	readonly update: SessionUpdate;
}

export interface DesktopSessionImageRequest extends DesktopSessionRequest {
	readonly imageId: string;
}

export interface DesktopSessionImageResponse {
	readonly data: string;
	readonly mimeType: string;
}

export type DesktopQueueSource = "sdk-steering" | "sdk-follow-up" | "auto" | "deferred";
export type DesktopQueueAction = "cancel" | "edit" | "send-now";

export interface DesktopQueuedImage {
	readonly type: "image";
	readonly data: string;
	readonly mimeType: string;
}

export interface DesktopQueuedUserMessage {
	readonly id: string;
	readonly promptText: string;
	readonly displayText: string;
	readonly images: readonly DesktopQueuedImage[];
}

export interface DesktopQueueItem {
	readonly id: string;
	readonly source: DesktopQueueSource;
	readonly mode: "steering" | "follow-up";
	readonly index: number;
	readonly text: string;
	readonly message?: DesktopQueuedUserMessage;
}

export interface DesktopQueueStateResponse {
	readonly sessionId: string;
	readonly items: readonly DesktopQueueItem[];
}

export interface DesktopQueueSubmitRequest extends DesktopSessionRequest {
	readonly prompt: readonly ContentBlock[];
	readonly displayText: string;
	readonly _meta?: Record<string, unknown> | null;
}

export interface DesktopQueueSubmitResponse {
	readonly disposition: "steering" | "auto" | "deferred";
	readonly itemId: string;
}

export interface DesktopQueueActionRequest extends DesktopSessionRequest {
	readonly source: DesktopQueueSource;
	readonly index: number;
	readonly text: string;
	readonly action: DesktopQueueAction;
}

export interface DesktopQueueActionResponse {
	readonly message?: DesktopQueuedUserMessage;
	readonly interruptRequired?: boolean;
}

export interface DesktopQueueConsumedNotification {
	readonly sessionId: string;
	readonly message: DesktopQueuedUserMessage;
}

export type DesktopRegistryResourceType = "skill" | "agent";
export type DesktopRegistryProjectScope = "tasks" | "plans" | "todo" | "project";

export type DesktopRegistryActionRequest = DesktopSessionRequest & (
	| { readonly action: "refresh" | "configure" | "project-key" }
	| {
		readonly action: "install" | "update" | "push" | "uninstall" | "remove";
		readonly type: DesktopRegistryResourceType;
		readonly name: string;
	}
	| {
		readonly action: "push-project" | "pull-project";
		readonly scope: DesktopRegistryProjectScope;
	}
);

export function parseDesktopSessionRequest(value: unknown): DesktopSessionRequest {
	if (!isRecord(value) || typeof value.sessionId !== "string" || value.sessionId.length === 0) {
		throw new RequestError(ERROR_INVALID_PARAMS, "request requires a non-empty string sessionId field");
	}
	return { sessionId: value.sessionId };
}

export function parseDesktopSessionHistoryRequest(value: unknown): DesktopSessionHistoryRequest {
	const session = parseDesktopSessionRequest(value);
	if (!isRecord(value) || (value.full !== undefined && typeof value.full !== "boolean")) {
		throw new RequestError(ERROR_INVALID_PARAMS, "pix/session/history full must be a boolean when provided");
	}
	return value.full === undefined ? session : { ...session, full: value.full };
}

export function parseDesktopResumePathRequest(value: unknown): DesktopResumePathRequest {
	const session = parseDesktopSessionRequest(value);
	if (!isRecord(value) || typeof value.path !== "string" || value.path.trim().length === 0) {
		throw new RequestError(ERROR_INVALID_PARAMS, "request requires a non-empty string path field");
	}
	return { ...session, path: value.path };
}

export function parseDesktopEnhancePromptRequest(value: unknown): DesktopEnhancePromptRequest {
	const session = parseDesktopSessionRequest(value);
	if (!isRecord(value) || typeof value.draft !== "string" || value.draft.trim().length < 3) {
		throw new RequestError(ERROR_INVALID_PARAMS, "pix/prompt/enhance requires a draft with at least 3 characters");
	}
	return { ...session, draft: value.draft };
}

export function parseDesktopGitAssistantRequest(value: unknown): DesktopGitAssistantRequest {
	const session = parseDesktopSessionRequest(value);
	if (
		!isRecord(value)
		|| (value.kind !== "review" && value.kind !== "commit-message")
		|| typeof value.diff !== "string"
		|| value.diff.trim().length === 0
		|| value.diff.length > 200_000
	) {
		throw new RequestError(ERROR_INVALID_PARAMS, "pix/git/assist requires kind and a non-empty diff up to 200000 characters");
	}
	return { ...session, kind: value.kind, diff: value.diff };
}

export function parseDesktopUserMessageActionRequest(value: unknown): DesktopUserMessageActionRequest {
	const session = parseDesktopSessionRequest(value);
	if (
		!isRecord(value)
		|| typeof value.entryId !== "string"
		|| value.entryId.length === 0
		|| (value.action !== "copy" && value.action !== "undo")
	) {
		throw new RequestError(ERROR_INVALID_PARAMS, "user-message action requires entryId and action copy|undo");
	}
	return { ...session, entryId: value.entryId, action: value.action };
}

export function parseDesktopImportSessionRequest(value: unknown): DesktopImportSessionRequest {
	const session = parseDesktopSessionRequest(value);
	if (!isRecord(value) || typeof value.path !== "string" || value.path.trim().length === 0) {
		throw new RequestError(ERROR_INVALID_PARAMS, "pix/session/import requires a non-empty string path field");
	}
	return { ...session, path: value.path };
}

export function parseDesktopToolResultRequest(value: unknown): DesktopToolResultRequest {
	const session = parseDesktopSessionRequest(value);
	if (!isRecord(value) || typeof value.toolCallId !== "string" || value.toolCallId.length === 0) {
		throw new RequestError(ERROR_INVALID_PARAMS, "request requires a non-empty string toolCallId field");
	}
	return { ...session, toolCallId: value.toolCallId };
}

export function parseDesktopSessionImageRequest(value: unknown): DesktopSessionImageRequest {
	const session = parseDesktopSessionRequest(value);
	if (!isRecord(value) || typeof value.imageId !== "string" || value.imageId.length === 0) {
		throw new RequestError(ERROR_INVALID_PARAMS, "request requires a non-empty string imageId field");
	}
	return { ...session, imageId: value.imageId };
}

export function parseDesktopQueueSubmitRequest(value: unknown): DesktopQueueSubmitRequest {
	const session = parseDesktopSessionRequest(value);
	if (!isRecord(value) || !Array.isArray(value.prompt) || typeof value.displayText !== "string") {
		throw new RequestError(ERROR_INVALID_PARAMS, "queue message requires prompt blocks and displayText");
	}
	return {
		...session,
		prompt: value.prompt as ContentBlock[],
		displayText: value.displayText,
		...(isRecord(value._meta) ? { _meta: value._meta } : {}),
	};
}

export function parseDesktopQueueActionRequest(value: unknown): DesktopQueueActionRequest {
	const session = parseDesktopSessionRequest(value);
	if (
		!isRecord(value)
		|| !["sdk-steering", "sdk-follow-up", "auto", "deferred"].includes(String(value.source))
		|| !Number.isSafeInteger(value.index)
		|| Number(value.index) < 0
		|| typeof value.text !== "string"
		|| !["cancel", "edit", "send-now"].includes(String(value.action))
	) {
		throw new RequestError(ERROR_INVALID_PARAMS, "invalid queue action request");
	}
	return {
		...session,
		source: value.source as DesktopQueueSource,
		index: Number(value.index),
		text: value.text,
		action: value.action as DesktopQueueAction,
	};
}

export function parseDesktopRegistryActionRequest(value: unknown): DesktopRegistryActionRequest {
	const session = parseDesktopSessionRequest(value);
	if (!isRecord(value) || typeof value.action !== "string") {
		throw new RequestError(ERROR_INVALID_PARAMS, "registry action request requires an action");
	}
	if (value.action === "refresh" || value.action === "configure" || value.action === "project-key") {
		return { ...session, action: value.action };
	}
	if (["install", "update", "push", "uninstall", "remove"].includes(value.action)) {
		if (
			(value.type !== "skill" && value.type !== "agent")
			|| typeof value.name !== "string"
			|| !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value.name)
			|| value.name.includes("..")
		) {
			throw new RequestError(ERROR_INVALID_PARAMS, "invalid registry resource action request");
		}
		return {
			...session,
			action: value.action as "install" | "update" | "push" | "uninstall" | "remove",
			type: value.type,
			name: value.name,
		};
	}
	if (value.action === "push-project" || value.action === "pull-project") {
		if (!["tasks", "plans", "todo", "project"].includes(String(value.scope))) {
			throw new RequestError(ERROR_INVALID_PARAMS, "invalid registry project scope");
		}
		return {
			...session,
			action: value.action,
			scope: value.scope as DesktopRegistryProjectScope,
		};
	}
	throw new RequestError(ERROR_INVALID_PARAMS, `unsupported registry action: ${value.action}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
