import type { Entry } from "../types.js";
import { isRecord } from "../guards.js";
import { createId } from "../id.js";
import { isOnlyHiddenMetadata } from "../../markdown-format.js";
import { extractImageContents, renderContent, renderUserMessageContent, stringifyUnknown } from "../rendering/message-content.js";
import { THINKING_TOOL_NAME } from "../constants.js";
import { PIX_SESSION_ENTRY_ID_FIELD, PIX_SYSTEM_MESSAGE_CUSTOM_TYPE } from "./pix-system-message.js";

type ToolResultRecord = {
	content: readonly unknown[];
	details?: unknown;
	isError: boolean;
	toolName?: string;
};

type SubagentsToolResultObserveOptions = {
	showSnapshot?: boolean;
};

const HISTORICAL_SUBAGENTS_OBSERVATION: SubagentsToolResultObserveOptions = { showSnapshot: false };

export type LoadSessionHistoryOptions = {
	messages: readonly unknown[] | undefined;
	addEntry: (entry: Entry) => void;
	setToolEntryId: (toolCallId: string, entryId: string) => void;
	toolDefaultExpanded: (toolName: string) => boolean;
	observeSubagentsToolResult: (toolName: string, details: unknown, options?: SubagentsToolResultObserveOptions) => void;
	observeTodoToolResult: (toolName: string, details: unknown, isError: boolean) => void;
};

export type LoadSessionHistoryAsyncOptions = LoadSessionHistoryOptions & {
	prependEntries: (entries: readonly Entry[]) => void;
	render: () => void;
	isCancelled: () => boolean;
	chunkSize?: number;
	tailMessageCount?: number;
	lazyOlderHistory?: boolean;
	olderMessagesReader?: OlderSessionHistoryMessagesReader | undefined;
	onOlderLoaderReady?: (loader: SessionHistoryOlderLoader | undefined) => void;
};

export type LoadOlderSessionHistoryOptions = {
	render?: boolean;
	onPrependedEntries?: (entries: readonly Entry[]) => void;
};

export type SessionHistoryOlderLoader = {
	hasOlder(): boolean;
	isLoading(): boolean;
	loadedMessageCount(): number;
	totalMessageCount(): number;
	loadOlder(options?: LoadOlderSessionHistoryOptions): Promise<boolean>;
};

export type OlderSessionHistoryMessagesReader = {
	hasOlder(): boolean;
	readOlder(limit: number): Promise<readonly unknown[]>;
};

const DEFAULT_HISTORY_CHUNK_SIZE = 50;
const DEFAULT_HISTORY_TAIL_MESSAGE_COUNT = 80;

export function loadSessionHistoryEntries(options: LoadSessionHistoryOptions): void {
	const { messages } = options;
	if (!messages || messages.length === 0) return;

	const toolResults = buildToolResults(messages, options, 0, messages.length);
	addSessionHistoryRangeEntries(messages, 0, messages.length, toolResults, options.addEntry, options);
}

export async function loadSessionHistoryEntriesAsync(options: LoadSessionHistoryAsyncOptions): Promise<boolean> {
	const { messages } = options;
	if (!messages || messages.length === 0) return !options.isCancelled();

	const chunkSize = Math.max(1, options.chunkSize ?? DEFAULT_HISTORY_CHUNK_SIZE);
	const tailMessageCount = Math.max(1, options.tailMessageCount ?? DEFAULT_HISTORY_TAIL_MESSAGE_COUNT);
	const toolResults = new Map<string, ToolResultRecord>();

	if (options.isCancelled()) return false;
	const tailStart = expandedTailStart(messages, Math.max(0, messages.length - tailMessageCount));
	buildToolResults(messages, options, tailStart, messages.length, toolResults);
	addSessionHistoryRangeEntries(messages, tailStart, messages.length, toolResults, options.addEntry, options);
	options.render();
	await yieldToEventLoop();

	if (options.lazyOlderHistory) {
		const loader = createOlderHistoryLoader(messages, options, chunkSize, toolResults, tailStart, options.olderMessagesReader);
		options.onOlderLoaderReady?.(loader.hasOlder() ? loader : undefined);
		return !options.isCancelled();
	}

	for (let end = tailStart; end > 0; end -= chunkSize) {
		if (options.isCancelled()) return false;
		const start = Math.max(0, end - chunkSize);
		buildToolResults(messages, options, start, end, toolResults);
		const entries: Entry[] = [];
		addSessionHistoryRangeEntries(messages, start, end, toolResults, (entry) => entries.push(entry), options);
		if (entries.length > 0) options.prependEntries(entries);
		options.render();
		await yieldToEventLoop();
	}

	return !options.isCancelled();
}

function createOlderHistoryLoader(
	messages: readonly unknown[],
	options: LoadSessionHistoryAsyncOptions,
	chunkSize: number,
	toolResults: Map<string, ToolResultRecord>,
	initialEnd: number,
	olderMessagesReader: OlderSessionHistoryMessagesReader | undefined,
): SessionHistoryOlderLoader {
	let nextEnd = initialEnd;
	let loading = false;
	let externallyLoadedMessageCount = 0;

	return {
		hasOlder: () => nextEnd > 0 || olderMessagesReader?.hasOlder() === true,
		isLoading: () => loading,
		loadedMessageCount: () => Math.max(0, messages.length - nextEnd) + externallyLoadedMessageCount,
		totalMessageCount: () => messages.length + externallyLoadedMessageCount,
		async loadOlder(loadOptions: LoadOlderSessionHistoryOptions = {}): Promise<boolean> {
			if (loading) return !options.isCancelled();
			if (nextEnd <= 0 && olderMessagesReader?.hasOlder() !== true) return !options.isCancelled();

			loading = true;
			let didPrependEntries = false;
			try {
				while (!options.isCancelled() && (nextEnd > 0 || olderMessagesReader?.hasOlder() === true)) {
					const batch = nextEnd > 0
						? inMemoryOlderMessagesBatch(messages, chunkSize, nextEnd)
						: await externalOlderMessagesBatch(olderMessagesReader, chunkSize);
					if (!batch) break;

					const { batchMessages } = batch;
					if (batch.external) externallyLoadedMessageCount += batchMessages.length;
					buildToolResults(batchMessages, options, 0, batchMessages.length, toolResults);
					const entries: Entry[] = [];
					addSessionHistoryRangeEntries(batchMessages, 0, batchMessages.length, toolResults, (entry) => entries.push(entry), options);
					nextEnd = batch.nextEnd;
					if (entries.length > 0) {
						options.prependEntries(entries);
						loadOptions.onPrependedEntries?.(entries);
						didPrependEntries = true;
						break;
					}
					await yieldToEventLoop();
				}

				if (options.isCancelled()) return false;
				if (didPrependEntries && loadOptions.render !== false) options.render();
				return true;
			} finally {
				loading = false;
				if (nextEnd <= 0 && olderMessagesReader?.hasOlder() !== true) options.onOlderLoaderReady?.(undefined);
			}
		},
	};
}

function inMemoryOlderMessagesBatch(messages: readonly unknown[], chunkSize: number, nextEnd: number): { batchMessages: readonly unknown[]; nextEnd: number; external: false } {
	const end = nextEnd;
	const start = Math.max(0, end - chunkSize);
	return { batchMessages: messages.slice(start, end), nextEnd: start, external: false };
}

async function externalOlderMessagesBatch(
	olderMessagesReader: OlderSessionHistoryMessagesReader | undefined,
	chunkSize: number,
): Promise<{ batchMessages: readonly unknown[]; nextEnd: number; external: true } | undefined> {
	if (!olderMessagesReader?.hasOlder()) return undefined;
	const batchMessages = await olderMessagesReader.readOlder(chunkSize);
	return batchMessages.length === 0 ? undefined : { batchMessages, nextEnd: 0, external: true };
}

function expandedTailStart(messages: readonly unknown[], initialStart: number): number {
	let start = initialStart;
	while (start > 0) {
		const message = messages[start];
		if (!isRecord(message) || message.role !== "toolResult") break;
		start -= 1;
	}
	return start;
}

function buildToolResults(
	messages: readonly unknown[],
	observers: Pick<LoadSessionHistoryOptions, "observeSubagentsToolResult">,
	start: number,
	end: number,
	toolResults = new Map<string, ToolResultRecord>(),
): Map<string, ToolResultRecord> {
	// Build a map from toolCallId -> tool result content for pairing.
	for (let index = start; index < end; index += 1) {
		const message = messages[index];
		if (isRecord(message) && message.role === "toolResult") {
			if (typeof message.toolName === "string") observers.observeSubagentsToolResult(message.toolName, message.details, HISTORICAL_SUBAGENTS_OBSERVATION);
			toolResults.set(String(message.toolCallId), {
				content: Array.isArray(message.content) ? message.content : [],
				...(message.details === undefined ? {} : { details: message.details }),
				isError: Boolean(message.isError),
				...(typeof message.toolName === "string" ? { toolName: message.toolName } : {}),
			});
		}
	}

	return toolResults;
}

function addSessionHistoryRangeEntries(
	messages: readonly unknown[],
	start: number,
	end: number,
	toolResults: ReadonlyMap<string, ToolResultRecord>,
	addEntry: (entry: Entry) => void,
	options: Omit<LoadSessionHistoryOptions, "messages" | "addEntry">,
): void {
	for (let index = start; index < end; index += 1) {
		const message = messages[index];
		if (!isRecord(message)) continue;

		if (message.role === "custom") {
			const entry = customMessageEntry(message);
			if (entry) addEntry(entry);
		} else if (message.role === "user") {
			const text = renderUserMessageContent(message.content);
			if (text) {
				const images = extractImageContents(message.content);
				const sessionEntryId = typeof message[PIX_SESSION_ENTRY_ID_FIELD] === "string" ? message[PIX_SESSION_ENTRY_ID_FIELD] : undefined;
				addEntry({ id: createId("user"), kind: "user", text, ...(sessionEntryId === undefined ? {} : { sessionEntryId }), ...(images.length === 0 ? {} : { images }) });
			}
		} else if (message.role === "assistant") {
			renderAssistantHistoryMessage(message, toolResults, { ...options, addEntry });
		}
		// toolResult messages are rendered inline with their tool entries, skip.
	}
}

async function yieldToEventLoop(): Promise<void> {
	await new Promise<void>((resolve) => { setTimeout(resolve, 0); });
}

export function customMessageEntry(message: Record<string, unknown>): Entry | undefined {
	if (message.display !== true) return undefined;

	const customType = typeof message.customType === "string" ? message.customType : "custom";
	const text = renderUserMessageContent(message.content);
	if (!text) return undefined;
	if (customType === PIX_SYSTEM_MESSAGE_CUSTOM_TYPE) return { id: createId("system"), kind: "system", text };

	return { id: createId("custom"), kind: "custom", customType, text };
}

function renderAssistantHistoryMessage(
	message: Record<string, unknown>,
	toolResults: ReadonlyMap<string, ToolResultRecord>,
	options: Omit<LoadSessionHistoryOptions, "messages">,
): void {
	const content = message.content;
	if (!Array.isArray(content)) return;

	let assistantText = "";
	let thinkingText = "";

	for (const block of content) {
		if (!isRecord(block)) continue;

		if (block.type === "toolCall") {
			// Flush accumulated text/thinking before tool call.
			if (thinkingText) {
				options.addEntry({
					id: createId("thinking"),
					kind: "thinking",
					text: thinkingText,
					expanded: options.toolDefaultExpanded(THINKING_TOOL_NAME),
					status: "done",
				});
				thinkingText = "";
			}
			if (assistantText && !isOnlyHiddenMetadata(assistantText)) {
				options.addEntry({ id: createId("assistant"), kind: "assistant", text: assistantText });
			}
			assistantText = "";

			const toolCallId = String(block.id ?? createId("tool"));
			const result = toolResults.get(toolCallId);
			const isPendingToolCall = result === undefined && message.stopReason !== "aborted" && message.stopReason !== "error";
			const toolName = result?.toolName ?? String(block.name ?? "unknown");
			const argsText = stringifyUnknown(block.arguments);
			const output = result ? renderContent(result.content) : "";
			const images = result ? extractImageContents(result.content) : [];
			if (result?.details !== undefined) options.observeSubagentsToolResult(toolName, result.details, HISTORICAL_SUBAGENTS_OBSERVATION);

			const entryId = createId("tool");
			options.addEntry({
				id: entryId,
				kind: "tool",
				toolCallId,
				toolName,
				argsText,
				output,
				...(images.length === 0 ? {} : { images }),
				...(result?.details === undefined ? {} : { details: result.details }),
				expanded: options.toolDefaultExpanded(toolName),
				isError: result?.isError ?? false,
				status: isPendingToolCall ? "running" : "done",
			});
			options.setToolEntryId(toolCallId, entryId);
		} else if (block.type === "thinking") {
			thinkingText += typeof block.thinking === "string" ? block.thinking : "";
		} else if (typeof block.text === "string") {
			assistantText += block.text;
		}
	}

	// Flush remaining text.
	if (thinkingText) {
		options.addEntry({
			id: createId("thinking"),
			kind: "thinking",
			text: thinkingText,
			expanded: options.toolDefaultExpanded(THINKING_TOOL_NAME),
			status: "done",
		});
	}
	if (assistantText && !isOnlyHiddenMetadata(assistantText)) {
		options.addEntry({ id: createId("assistant"), kind: "assistant", text: assistantText });
	}
}
