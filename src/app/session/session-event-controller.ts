import type { AgentSessionEvent, AgentSessionRuntime } from "@earendil-works/pi-coding-agent";
import type { ImageContent } from "../../input-editor.js";
import type { ConversationViewport } from "../rendering/conversation-viewport.js";
import { createId } from "../id.js";
import { extractImageContents, renderContent, renderUserMessageContent, stringifyUnknown } from "../rendering/message-content.js";
import { customMessageEntry, loadSessionHistoryEntries, loadSessionHistoryEntriesAsync, type LoadOlderSessionHistoryOptions, type SessionHistoryOlderLoader } from "./session-history.js";
import { sessionHistoryDisplayMessages, sessionHistoryOlderMessagesReader } from "./pix-system-message.js";
import type { Entry, SessionActivity } from "../types.js";
import { isRecord } from "../guards.js";
import type { WorkspaceMutation, WorkspaceMutationPreparation } from "../workspace/workspace-undo.js";

type ToolEntryUpdate = {
	toolName?: string;
	argsText?: string;
	output?: string;
	images?: ImageContent[];
	details?: unknown;
	isError?: boolean;
	status?: "running" | "done";
};

const DCP_MESSAGE_REFERENCE_PREFIX = "[dcp-id]: # (m";
const DCP_BLOCK_REFERENCE_PREFIX = "[dcp-block-id]: # (b";
const MAX_HISTORY_WINDOW_ENTRIES = 360;
const HISTORY_WINDOW_TARGET_ENTRIES = 300;

export type AppSessionEventControllerHost = {
	readonly entries: Entry[];
	runtime(): AgentSessionRuntime | undefined;
	conversationViewport(): ConversationViewport;
	conversationViewportColumns?(): number;
	onHistoryWindowPruned?(edge: "top" | "bottom", lineCount: number): void;
	isRunning(): boolean;
	render(): void;
	scheduleRender(): void;
	setStatus(status: string): void;
	restoreSessionStatus(): void;
	setSessionStatus(session: AgentSessionRuntime["session"] | undefined): void;
	setSessionActivity(activity: SessionActivity): void;
	updateQueuedMessageStatus(): void;
	prepareWorkspaceMutation(toolName: string, args: unknown): WorkspaceMutationPreparation | undefined;
	recordWorkspaceMutationForUserEntry(entryId: string, mutation: WorkspaceMutation): void;
	workspaceMutationFromToolExecution(input: {
		toolName: string;
		args: unknown;
		details: unknown;
		isError: boolean;
		preparation?: WorkspaceMutationPreparation | undefined;
	}): WorkspaceMutation | undefined;
	scheduleUserSessionEntryMetadataSync(): void;
	toolDefaultExpanded(toolName: string): boolean;
	observeSubagentsToolResult(toolName: string, details: unknown, options?: { showSnapshot?: boolean }): void;
	observeTodoToolResult(toolName: string, details: unknown, isError?: boolean): void;
	showToast(message: string, kind: "success" | "error" | "warning" | "info"): void;
};

export class AppSessionEventController {
	readonly entryRenderVersions = new Map<string, number>();

	private readonly toolEntryIdsByCallId = new Map<string, string>();
	private readonly toolMutationPreparationsByCallId = new Map<string, { userEntryId: string; args: unknown; preparation?: WorkspaceMutationPreparation }>();
	private olderHistoryLoader: SessionHistoryOlderLoader | undefined;
	private currentUserEntryId: string | undefined;
	private currentAssistantEntryId: string | undefined;
	private currentThinkingEntryId: string | undefined;
	private assistantTextBuffer = "";

	constructor(private readonly host: AppSessionEventControllerHost) {}

	reset(): void {
		this.toolEntryIdsByCallId.clear();
		this.toolMutationPreparationsByCallId.clear();
		this.currentUserEntryId = undefined;
		this.entryRenderVersions.clear();
		this.currentAssistantEntryId = undefined;
		this.currentThinkingEntryId = undefined;
		this.assistantTextBuffer = "";
		this.olderHistoryLoader = undefined;
	}

	loadSessionHistory(): void {
		const runtime = this.host.runtime();
		if (!runtime) return;

		loadSessionHistoryEntries({
			messages: sessionHistoryDisplayMessages(runtime.session),
			addEntry: (entry) => this.addEntry(entry),
			setToolEntryId: (toolCallId, entryId) => this.toolEntryIdsByCallId.set(toolCallId, entryId),
			toolDefaultExpanded: (toolName) => this.host.toolDefaultExpanded(toolName),
			observeSubagentsToolResult: (toolName, details, options) => this.host.observeSubagentsToolResult(toolName, details, options),
			observeTodoToolResult: (toolName, details, isError) => this.host.observeTodoToolResult(toolName, details, isError),
		});
	}

	async loadSessionHistoryAsync(options: { isCancelled: () => boolean; render: () => void; lazyOlderHistory?: boolean }): Promise<boolean> {
		const runtime = this.host.runtime();
		if (!runtime) return !options.isCancelled();
		this.olderHistoryLoader = undefined;

		return loadSessionHistoryEntriesAsync({
			messages: sessionHistoryDisplayMessages(runtime.session),
			olderMessagesReader: sessionHistoryOlderMessagesReader(runtime.session),
			addEntry: (entry) => this.addEntry(entry),
			prependEntries: (entries) => this.prependEntries(entries),
			setToolEntryId: (toolCallId, entryId) => this.toolEntryIdsByCallId.set(toolCallId, entryId),
			toolDefaultExpanded: (toolName) => this.host.toolDefaultExpanded(toolName),
			observeSubagentsToolResult: (toolName, details, options) => this.host.observeSubagentsToolResult(toolName, details, options),
			observeTodoToolResult: (toolName, details, isError) => this.host.observeTodoToolResult(toolName, details, isError),
			isCancelled: options.isCancelled,
			render: options.render,
			lazyOlderHistory: options.lazyOlderHistory === true,
			onOlderLoaderReady: (loader) => {
				this.olderHistoryLoader = loader;
			},
		});
	}

	hasOlderSessionHistory(): boolean {
		return this.olderHistoryLoader?.hasOlder() === true;
	}

	isLoadingOlderSessionHistory(): boolean {
		return this.olderHistoryLoader?.isLoading() === true;
	}

	async loadOlderSessionHistory(options: LoadOlderSessionHistoryOptions = {}): Promise<boolean> {
		return this.olderHistoryLoader?.loadOlder(options) ?? false;
	}

	handleSessionEvent(event: AgentSessionEvent): void {
		switch (event.type) {
			case "session_info_changed":
				this.host.setSessionStatus(this.host.runtime()?.session);
				break;
			case "message_start":
				this.handleMessageStart(event.message);
				break;
			case "message_end":
				this.handleMessageEnd(event.message);
				break;
			case "agent_start":
				this.host.setSessionActivity("running");
				this.host.setSessionStatus(this.host.runtime()?.session);
				break;
			case "thinking_level_changed":
				this.host.setSessionStatus(this.host.runtime()?.session);
				break;
			case "agent_end":
				this.finishCurrentThinkingEntry();
				this.clearCurrentAssistantState();
				this.currentUserEntryId = undefined;
				this.host.setSessionActivity("idle");
				this.host.setSessionStatus(this.host.runtime()?.session);
				break;
			case "queue_update":
				this.host.updateQueuedMessageStatus();
				break;
			case "message_update":
				this.handleMessageUpdate(event.assistantMessageEvent);
				break;
			case "tool_execution_start":
				this.finishCurrentThinkingEntry();
				this.flushAssistantTextBuffer(true);
				this.currentAssistantEntryId = undefined;
				this.host.setSessionActivity("running");
				this.prepareToolWorkspaceMutation(event.toolCallId, event.toolName, event.args);
				this.upsertToolEntry(event.toolCallId, {
					toolName: event.toolName,
					argsText: stringifyUnknown(event.args),
					status: "running",
				});
				break;
			case "tool_execution_update":
				this.host.setSessionActivity("running");
				this.host.observeSubagentsToolResult(event.toolName, isRecord(event.partialResult) ? event.partialResult.details : undefined);
				this.host.observeTodoToolResult(event.toolName, isRecord(event.partialResult) ? event.partialResult.details : undefined);
				this.upsertToolEntry(event.toolCallId, {
					toolName: event.toolName,
					argsText: stringifyUnknown(event.args),
					output: renderContent(event.partialResult.content),
					images: extractImageContents(event.partialResult.content),
					...(isRecord(event.partialResult) && event.partialResult.details !== undefined ? { details: event.partialResult.details } : {}),
					status: "running",
				});
				break;
			case "tool_execution_end":
				this.host.setSessionActivity(this.host.runtime()?.session.isStreaming ? "running" : "idle");
				this.recordToolWorkspaceMutation(event.toolCallId, event.toolName, event.result.details, event.isError);
				if (this.currentUserEntryId) this.host.scheduleUserSessionEntryMetadataSync();
				this.host.observeSubagentsToolResult(event.toolName, isRecord(event.result) ? event.result.details : undefined);
				this.host.observeTodoToolResult(event.toolName, isRecord(event.result) ? event.result.details : undefined, event.isError);
				this.upsertToolEntry(event.toolCallId, {
					toolName: event.toolName,
					output: renderContent(event.result.content),
					images: extractImageContents(event.result.content),
					details: event.result.details,
					isError: event.isError,
					status: "done",
				});
				break;
			case "compaction_start":
				this.host.setSessionActivity("running");
				this.host.setStatus(`compacting (${event.reason})`);
				break;
			case "compaction_end": {
				this.host.setSessionActivity(this.host.runtime()?.session.isStreaming ? "running" : "idle");
				this.host.restoreSessionStatus();
				const message = event.result
					? `Compacted ${event.result.tokensBefore} tokens`
					: event.aborted
						? "Compaction cancelled"
						: event.errorMessage ?? "Compaction failed";
				this.host.showToast(message, event.result ? "success" : event.aborted ? "info" : "error");
				break;
			}
			case "auto_retry_start":
				this.host.setSessionActivity("running");
				this.host.setStatus(`retry ${event.attempt}/${event.maxAttempts}`);
				break;
			case "auto_retry_end":
				this.host.setSessionActivity(this.host.runtime()?.session.isStreaming ? "running" : "idle");
				this.host.restoreSessionStatus();
				this.host.showToast(
					event.success ? "Retry succeeded" : `Retry failed: ${event.finalError}`,
					event.success ? "success" : "error",
				);
				break;
			default:
				break;
		}
		this.host.scheduleRender();
	}

	addCustomMessageEntry(message: Record<string, unknown>): void {
		const entry = customMessageEntry(message);
		if (entry) this.addEntry(entry);
	}

	findEntry(id: string): Entry | undefined {
		return this.host.entries.find((entry) => entry.id === id);
	}

	findUserEntry(id: string): Extract<Entry, { kind: "user" }> | undefined {
		const entry = this.findEntry(id);
		return entry?.kind === "user" ? entry : undefined;
	}

	touchEntry(entry: Entry): void {
		this.entryRenderVersions.set(entry.id, (this.entryRenderVersions.get(entry.id) ?? 0) + 1);
		this.host.conversationViewport().deleteEntry(entry.id);
	}

	addEntry(entry: Entry): void {
		this.host.entries.push(entry);
		this.entryRenderVersions.set(entry.id, 1);
		this.host.conversationViewport().deleteEntry(entry.id);
		this.pruneHistoryWindow("top");
	}

	private prependEntries(entries: readonly Entry[]): void {
		this.host.entries.unshift(...entries);
		for (const entry of entries) {
			this.entryRenderVersions.set(entry.id, 1);
			this.host.conversationViewport().deleteEntry(entry.id);
		}
		this.pruneHistoryWindow("bottom");
	}

	private pruneHistoryWindow(edge: "top" | "bottom"): void {
		const removeCount = this.host.entries.length - MAX_HISTORY_WINDOW_ENTRIES;
		if (removeCount <= 0) return;

		const targetRemoveCount = Math.max(removeCount, this.host.entries.length - HISTORY_WINDOW_TARGET_ENTRIES);
		const removedEntryIds = edge === "top"
			? this.host.entries.slice(0, targetRemoveCount).map((entry) => entry.id)
			: this.host.entries.slice(Math.max(0, this.host.entries.length - targetRemoveCount)).map((entry) => entry.id);
		const removedLineCount = this.measuredLineCountForEntries(removedEntryIds);
		const removed = edge === "top"
			? this.host.entries.splice(0, targetRemoveCount)
			: this.host.entries.splice(Math.max(0, this.host.entries.length - targetRemoveCount), targetRemoveCount);
		for (const entry of removed) this.forgetEntry(entry);
		this.host.onHistoryWindowPruned?.(edge, removedLineCount);
	}

	private measuredLineCountForEntries(entryIds: readonly string[]): number {
		if (entryIds.length === 0) return 0;
		const viewport = this.host.conversationViewport();
		if (typeof viewport.measuredLineCountForEntries !== "function") return 0;
		return viewport.measuredLineCountForEntries(this.host.conversationViewportColumns?.() ?? 80, entryIds);
	}

	private forgetEntry(entry: Entry): void {
		this.entryRenderVersions.delete(entry.id);
		this.host.conversationViewport().deleteEntry(entry.id);
		if (entry.kind !== "tool") return;
		for (const [toolCallId, entryId] of this.toolEntryIdsByCallId) {
			if (entryId === entry.id) this.toolEntryIdsByCallId.delete(toolCallId);
		}
	}

	addSessionAbortedEntry(): void {
		this.finishCurrentThinkingEntry();
		this.clearCurrentAssistantState();
		this.addEntry({ id: createId("session-aborted"), kind: "session-aborted", text: "Session aborted." });
	}

	private handleMessageStart(message: unknown): void {
		if (isRecord(message) && message.role === "custom") {
			this.addCustomMessageEntry(message);
			return;
		}

		if (isRecord(message) && message.role === "user") {
			const text = renderUserMessageContent(message.content);
			if (!text) return;
			const images = extractImageContents(message.content);

			const entryId = createId("user");
			this.addEntry({
				id: entryId,
				kind: "user",
				text,
				workspaceMutations: [],
				...(images.length === 0 ? {} : { images }),
			});
			this.currentUserEntryId = entryId;
			return;
		}

		if (isRecord(message) && message.role === "assistant") this.clearCurrentAssistantState();
	}

	private handleMessageEnd(message: unknown): void {
		if (isRecord(message) && message.role === "user") {
			this.host.scheduleUserSessionEntryMetadataSync();
		}
		if (isRecord(message) && message.role === "assistant") {
			this.finishCurrentThinkingEntry();
			this.flushAssistantTextBuffer(true);
			this.clearCurrentAssistantState();
		}
	}

	private prepareToolWorkspaceMutation(toolCallId: string, toolName: string, args: unknown): void {
		const userEntryId = this.currentUserEntryId;
		if (!userEntryId) return;

		const preparation = this.host.prepareWorkspaceMutation(toolName, args);
		this.toolMutationPreparationsByCallId.set(toolCallId, {
			userEntryId,
			args,
			...(preparation === undefined ? {} : { preparation }),
		});
	}

	private recordToolWorkspaceMutation(toolCallId: string, toolName: string, details: unknown, isError: boolean): void {
		const prepared = this.toolMutationPreparationsByCallId.get(toolCallId);
		if (!prepared) return;
		this.toolMutationPreparationsByCallId.delete(toolCallId);

		const mutation = this.host.workspaceMutationFromToolExecution({
			toolName,
			args: prepared.args,
			details,
			isError,
			preparation: prepared.preparation,
		});
		if (!mutation) return;

		this.host.recordWorkspaceMutationForUserEntry(prepared.userEntryId, mutation);
	}

	private handleMessageUpdate(
		assistantEvent: Extract<AgentSessionEvent, { type: "message_update" }>["assistantMessageEvent"],
	): void {
		switch (assistantEvent.type) {
			case "text_delta":
				this.finishCurrentThinkingEntry();
				this.host.setSessionActivity("running");
				this.appendAssistantText(assistantEvent.delta);
				break;
			case "thinking_delta":
				this.host.setSessionActivity("thinking");
				this.appendThinkingText(assistantEvent.delta);
				break;
			case "done":
				this.finishCurrentThinkingEntry();
				this.flushAssistantTextBuffer(true);
				this.clearCurrentAssistantState();
				this.host.setSessionActivity(this.host.runtime()?.session.isStreaming ? "running" : "idle");
				break;
			case "error":
				this.finishCurrentThinkingEntry();
				this.flushAssistantTextBuffer(true);
				this.host.setSessionActivity(this.host.runtime()?.session.isStreaming ? "running" : "idle");
				this.addEntry({ id: createId("error"), kind: "error", text: assistantEvent.error.errorMessage ?? assistantEvent.reason });
				break;
			default:
				break;
		}
	}

	private appendAssistantText(delta: string): void {
		this.assistantTextBuffer += delta;
		this.flushAssistantTextBuffer(false);
	}

	private flushAssistantTextBuffer(final: boolean): void {
		const visibleText = this.drainAssistantTextBuffer(final);
		if (!visibleText) return;

		let entry = this.currentAssistantEntryId ? this.findEntry(this.currentAssistantEntryId) : undefined;
		if (!entry || entry.kind !== "assistant") {
			entry = { id: createId("assistant"), kind: "assistant", text: "" };
			this.addEntry(entry);
			this.currentAssistantEntryId = entry.id;
		}
		entry.text += visibleText;

		this.touchEntry(entry);
	}

	private drainAssistantTextBuffer(final: boolean): string {
		let visibleText = "";

		for (;;) {
			const newlineIndex = this.assistantTextBuffer.indexOf("\n");
			if (newlineIndex === -1) break;

			const line = this.assistantTextBuffer.slice(0, newlineIndex);
			this.assistantTextBuffer = this.assistantTextBuffer.slice(newlineIndex + 1);
			if (shouldDropAssistantStreamLine(line, this.hasVisibleAssistantText(visibleText))) continue;
			visibleText += `${line}\n`;
		}

		if (!this.assistantTextBuffer) return visibleText;

		if (shouldHoldAssistantStreamTail(this.assistantTextBuffer)) {
			if (final) this.assistantTextBuffer = "";
			return visibleText;
		}

		visibleText += this.assistantTextBuffer;
		this.assistantTextBuffer = "";
		return visibleText;
	}

	private hasVisibleAssistantText(pendingVisibleText: string): boolean {
		if (pendingVisibleText.length > 0) return true;
		const entry = this.currentAssistantEntryId ? this.findEntry(this.currentAssistantEntryId) : undefined;
		return entry?.kind === "assistant" && entry.text.length > 0;
	}

	private appendThinkingText(delta: string): void {
		let entry = this.currentThinkingEntryId ? this.findEntry(this.currentThinkingEntryId) : undefined;
		if (!entry || entry.kind !== "thinking") {
			entry = { id: createId("thinking"), kind: "thinking", text: "", expanded: false, status: "running" };
			this.addEntry(entry);
			this.currentThinkingEntryId = entry.id;
		}
		entry.status = "running";
		entry.text += delta;
		this.touchEntry(entry);
	}

	private finishCurrentThinkingEntry(): void {
		const entry = this.currentThinkingEntryId ? this.findEntry(this.currentThinkingEntryId) : undefined;
		if (entry?.kind === "thinking" && entry.status !== "done") {
			entry.status = "done";
			this.touchEntry(entry);
		}
		this.currentThinkingEntryId = undefined;
	}

	private upsertToolEntry(toolCallId: string, update: ToolEntryUpdate): void {
		const existingId = this.toolEntryIdsByCallId.get(toolCallId);
		const existing = existingId ? this.findEntry(existingId) : undefined;
		if (existing?.kind === "tool") {
			existing.toolName = update.toolName ?? existing.toolName;
			existing.argsText = update.argsText ?? existing.argsText;
			existing.output = update.output ?? existing.output;
			if ("images" in update) existing.images = update.images;
			if ("details" in update) existing.details = update.details;
			existing.isError = update.isError ?? existing.isError;
			existing.status = update.status ?? existing.status;
			this.touchEntry(existing);
			return;
		}

		const entry: Entry = {
			id: createId("tool"),
			kind: "tool",
			toolCallId,
			toolName: update.toolName ?? "tool",
			argsText: update.argsText ?? "{}",
			output: update.output ?? "",
			...(update.images === undefined ? {} : { images: update.images }),
			...("details" in update ? { details: update.details } : {}),
			expanded: this.host.toolDefaultExpanded(update.toolName ?? "tool"),
			isError: update.isError ?? false,
			status: update.status ?? "running",
		};
		this.toolEntryIdsByCallId.set(toolCallId, entry.id);
		this.addEntry(entry);
	}

	private clearCurrentAssistantState(): void {
		this.currentAssistantEntryId = undefined;
		this.currentThinkingEntryId = undefined;
		this.assistantTextBuffer = "";
	}
}

function shouldDropAssistantStreamLine(line: string, hasVisibleText: boolean): boolean {
	if (line.trim().length === 0 && !hasVisibleText) return true;
	return isHiddenMarkdownMetadataLine(line);
}

function shouldHoldAssistantStreamTail(text: string): boolean {
	if (text.trim().length === 0) return true;
	return isPotentialDcpMetadataLine(text);
}

function isHiddenMarkdownMetadataLine(line: string): boolean {
	return isMarkdownReferenceDefinition(line) || isPotentialDcpMetadataLine(line);
}

function isMarkdownReferenceDefinition(line: string): boolean {
	return /^ {0,3}\[[^\]\n]+\]:[ \t]*\S.*$/u.test(line);
}

function isPotentialDcpMetadataLine(line: string): boolean {
	const content = line.replace(/^ {0,3}/u, "");
	if (content.length === 0) return false;
	return isPotentialDcpReference(content, DCP_MESSAGE_REFERENCE_PREFIX) || isPotentialDcpReference(content, DCP_BLOCK_REFERENCE_PREFIX);
}

function isPotentialDcpReference(content: string, markerPrefix: string): boolean {
	return markerPrefix.startsWith(content) || (content.startsWith(markerPrefix) && /^\d*\)?$/u.test(content.slice(markerPrefix.length)));
}
