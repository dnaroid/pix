/**
 * Translation of pi `JsonAgentSessionEvent`s into ACP `session/update`
 * notifications (roadmap step 2 of acp/README.md).
 *
 * Mapping (pi → ACP):
 * - `message_update` + `text_delta`     → `agent_message_chunk` (text)
 * - `message_update` + `thinking_delta` → `agent_thought_chunk` (text)
 * - `tool_execution_start`              → `tool_call` (title/kind/locations from args)
 * - `tool_execution_update`             → `tool_call_update` (streamed content)
 * - `tool_execution_end`                → `tool_call_update` (status + content + diffs)
 *
 * The translator is stateful per pi session: tool call arguments recorded at
 * `tool_execution_start` are reused at `tool_execution_end` (pi does not
 * repeat them there) to build structured diffs and locations.
 *
 * Lifecycle events (`agent_start`/`agent_end`/`agent_settled`) are consumed by
 * the prompt runner in `pix-acp-agent.ts`, not by this translator.
 */

import type { JsonAgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type {
	Diff,
	SessionNotification,
	SessionUpdate,
	ToolCallContent,
	ToolCallLocation,
	ToolKind,
} from "@agentclientprotocol/sdk";

/** The JSON wire shape of a pi `message_update` event. */
type JsonMessageUpdateEvent = Extract<JsonAgentSessionEvent, { type: "message_update" }>;
type AssistantMessageEvent = JsonMessageUpdateEvent["assistantMessageEvent"];

export interface TranslateContext {
	/** ACP session id the notifications belong to. */
	readonly sessionId: string;
	/** Session cwd; used to resolve relative tool paths for locations/diffs. */
	readonly cwd: string;
}

interface RecordedToolCall {
	readonly toolName: string;
	readonly args: unknown;
}

export class EventTranslator {
	private readonly toolCalls = new Map<string, RecordedToolCall>();

	constructor(private readonly context: TranslateContext) {}

	translate(event: JsonAgentSessionEvent): SessionNotification[] {
		const updates = this.eventToUpdates(event);
		return updates.map((update) => ({ sessionId: this.context.sessionId, update }));
	}

	private eventToUpdates(event: JsonAgentSessionEvent): SessionUpdate[] {
		switch (event.type) {
			case "message_update":
				return messageUpdateToUpdates(event.assistantMessageEvent);
			case "tool_execution_start":
				return [this.toolExecutionStartToUpdate(event)];
			case "tool_execution_update":
				return toolExecutionUpdateToUpdate(event);
			case "tool_execution_end":
				return [this.toolExecutionEndToUpdate(event)];
			default:
				// Lifecycle events are handled by the prompt runner; bash output
				// streaming and bookkeeping events have no ACP mapping yet.
				return [];
		}
	}

	private toolExecutionStartToUpdate(event: Extract<JsonAgentSessionEvent, { type: "tool_execution_start" }>): SessionUpdate {
		this.toolCalls.set(event.toolCallId, { toolName: event.toolName, args: event.args });
		const args = asRecord(event.args);
		// Tool names are matched case-insensitively: the pix tools suite
		// exposes capitalized aliases (Write/Edit/Read/...) of the pi tools.
		const name = event.toolName.toLowerCase();
		return {
			sessionUpdate: "tool_call",
			toolCallId: event.toolCallId,
			name: event.toolName,
			title: toolTitle(name, args),
			kind: toolKind(name),
			status: "in_progress",
			rawInput: event.args ?? undefined,
			locations: toolLocations(this.context, name, args),
		} as SessionUpdate;
	}

	private toolExecutionEndToUpdate(event: Extract<JsonAgentSessionEvent, { type: "tool_execution_end" }>): SessionUpdate {
		const recorded = this.toolCalls.get(event.toolCallId);
		const name = (recorded?.toolName ?? event.toolName).toLowerCase();
		const result = asRecord(event.result);
		const content = [...toolResultContent(result), ...toolResultDiffs(this.context, name, recorded?.args, event.isError)];
		this.toolCalls.delete(event.toolCallId);
		const update: Record<string, unknown> = {
			sessionUpdate: "tool_call_update",
			toolCallId: event.toolCallId,
			status: event.isError ? "failed" : "completed",
		};
		if (content.length > 0) update.content = content;
		const details = result?.["details"];
		if (details !== undefined) update.rawOutput = details;
		return update as SessionUpdate;
	}
}

function messageUpdateToUpdates(event: AssistantMessageEvent): SessionUpdate[] {
	if (event.type === "text_delta") {
		return [chunk("agent_message_chunk", event.delta)];
	}
	if (event.type === "thinking_delta") {
		return [chunk("agent_thought_chunk", event.delta)];
	}
	// text/thinking/toolcall start+end and stream done/error carry no
	// incremental display payload for ACP clients.
	return [];
}

function chunk(sessionUpdate: "agent_message_chunk" | "agent_thought_chunk", text: string): SessionUpdate {
	return {
		sessionUpdate,
		content: { type: "text", text },
	} as SessionUpdate;
}

function toolExecutionUpdateToUpdate(event: Extract<JsonAgentSessionEvent, { type: "tool_execution_update" }>): SessionUpdate[] {
	const content = toolResultContent(asRecord(event.partialResult));
	if (content.length === 0) return [];
	return [
		{
			sessionUpdate: "tool_call_update",
			toolCallId: event.toolCallId,
			content,
		} as SessionUpdate,
	];
}

/** Map pi tool result content blocks (text/image) to ACP tool call content. */
function toolResultContent(result: Record<string, unknown> | undefined): ToolCallContent[] {
	const blocks = result?.["content"];
	if (!Array.isArray(blocks)) return [];
	const content: ToolCallContent[] = [];
	for (const block of blocks) {
		const record = asRecord(block);
		if (!record) continue;
		if (record["type"] === "text" && typeof record["text"] === "string") {
			content.push({ type: "content", content: { type: "text", text: record["text"] } });
		} else if (record["type"] === "image" && typeof record["data"] === "string" && typeof record["mimeType"] === "string") {
			content.push({
				type: "content",
				content: { type: "image", data: record["data"], mimeType: record["mimeType"] },
			});
		}
	}
	return content;
}

/**
 * Structured diffs for file-mutating tools, computed from the recorded tool
 * call arguments (the source Zed needs to render an inline diff view).
 */
function toolResultDiffs(context: TranslateContext, toolName: string, args: unknown, isError: boolean): ToolCallContent[] {
	if (isError) return [];
	const record = asRecord(args);
	if (!record) return [];
	if (toolName === "edit") {
		const path = toolPath(record);
		if (!path) return [];
		const edits = record["edits"];
		if (!Array.isArray(edits)) return [];
		const diffs: ToolCallContent[] = [];
		for (const edit of edits) {
			const e = asRecord(edit);
			if (!e || typeof e["oldText"] !== "string" || typeof e["newText"] !== "string") continue;
			diffs.push(diffContent(context, path, e["oldText"], e["newText"]));
		}
		return diffs;
	}
	if (toolName === "write") {
		const path = toolPath(record);
		const text = record["content"];
		if (!path || typeof text !== "string") return [];
		return [diffContent(context, path, null, text)];
	}
	return [];
}

function diffContent(context: TranslateContext, path: string, oldText: string | null, newText: string): ToolCallContent {
	const diff: Diff = { path: resolveToolPath(context, path), newText };
	if (oldText !== null) diff.oldText = oldText;
	return { type: "diff", ...diff };
}

const TOOL_KINDS: Record<string, ToolKind> = {
	read: "read",
	ls: "read",
	edit: "edit",
	write: "edit",
	find: "search",
	grep: "search",
	bash: "execute",
};

export function toolKind(toolName: string): ToolKind {
	return TOOL_KINDS[toolName] ?? "other";
}

export function toolTitle(toolName: string, args: Record<string, unknown> | undefined): string {
	const path = args ? toolPath(args) : undefined;
	switch (toolName) {
		case "read":
		case "edit":
		case "write":
		case "ls":
			return path ? `${cap(toolName)} ${path}` : cap(toolName);
		case "find":
		case "grep": {
			const pattern = args?.["pattern"];
			return typeof pattern === "string" ? `${cap(toolName)} ${pattern}` : cap(toolName);
		}
		case "bash": {
			const command = args?.["command"];
			if (typeof command !== "string" || command.length === 0) return "Bash";
			const firstLine = command.split("\n")[0]!.trim();
			// Cap the whole title at 80 chars: "Bash: " (6) + command + ellipsis.
			const budget = 80 - "Bash: ".length - 1;
			return firstLine.length > 80 - "Bash: ".length
				? `Bash: ${firstLine.slice(0, budget)}…`
				: `Bash: ${firstLine}`;
		}
		default:
			return toolName;
	}
}

export function toolLocations(context: TranslateContext, toolName: string, args: Record<string, unknown> | undefined): ToolCallLocation[] | undefined {
	const path = args ? toolPath(args) : undefined;
	if (!path) return undefined;
	switch (toolName) {
		case "read":
		case "edit":
		case "write":
		case "ls":
			return [{ path: resolveToolPath(context, path) }];
		default:
			return undefined;
	}
}

function toolPath(args: Record<string, unknown>): string | undefined {
	const path = args["file_path"] ?? args["path"];
	return typeof path === "string" && path.length > 0 ? path : undefined;
}

function resolveToolPath(context: TranslateContext, path: string): string {
	if (path.startsWith("/")) return path;
	return `${context.cwd.replace(/\/+$/, "")}/${path}`;
}

function cap(name: string): string {
	return name.charAt(0).toUpperCase() + name.slice(1);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}
