import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage, ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";
import { normalizeQuestionInput } from "./contract.js";
import type { QuestionToolInput } from "./types.js";

type Agent = AgentSession["agent"];
type AgentEvent = Parameters<Parameters<Agent["subscribe"]>[0]>[0];
type ToolResult = Awaited<ReturnType<Agent["state"]["tools"][number]["execute"]>>;

// The SDK has no public pending-tool resume API. Keep the pinned agent/session
// lifecycle adapter here rather than teaching either UI about transcript writes.
interface RecoveryAgent {
	runWithLifecycle(executor: (signal: AbortSignal) => Promise<void>): Promise<void>;
	processEvents(event: AgentEvent): Promise<void>;
}
interface RecoverySession {
	_isAgentRunActive: boolean;
	_agentRunAbortRequested: boolean;
	_runSystemPromptOptions: unknown;
	_handlePostAgentRun(): Promise<boolean>;
	_runBeforeSettleBoundary(): Promise<boolean>;
	_flushPendingBashMessages(): void;
	_flushPendingCustomMessages(): void;
	_emitAgentSettled(): Promise<void>;
	_failedResponse: unknown;
	_finishCancelledRetry(): void;
}
interface ToolRunner {
	runToolCall(call: ToolCall, options: {
		context: { messages: Agent["state"]["messages"]; tools: Agent["state"]["tools"] };
		assistantMessage: AssistantMessage;
		tools: Agent["state"]["tools"];
		signal: AbortSignal;
		beforeToolCall: Agent["beforeToolCall"];
		afterToolCall: Agent["afterToolCall"];
		onUpdate(result: ToolResult): void;
	}): Promise<{ result: ToolResult; isError: boolean }>;
}

const requireSdk = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"));
let runner: Promise<ToolRunner> | undefined;
const scheduled = new WeakMap<AgentSession, { cancel(): void }>();

/** Only the active interrupted turn is recoverable; never replay side-effect tools. */
export function pendingQuestions(messages: Agent["state"]["messages"]): { message: AssistantMessage; calls: ToolCall[] } | undefined {
	let index = messages.length - 1;
	while (index >= 0 && messages[index]?.role === "toolResult") index--;
	const message = messages[index];
	if (message?.role !== "assistant" || message.stopReason !== "toolUse") return;
	const results = new Set(messages.slice(index + 1).flatMap((item) => item.role === "toolResult" ? [item.toolCallId] : []));
	const calls = message.content.filter((item): item is ToolCall => item.type === "toolCall" && !results.has(item.id));
	if (!calls.length || calls.some((call) => call.name !== "question")) return;
	try {
		for (const call of calls) normalizeQuestionInput(call.arguments as unknown as QuestionToolInput);
	} catch { return; }
	return { message, calls };
}

/** Defer until bind/replay subscribers are attached. Rebinding cancels stale work. */
export function scheduleQuestionRecovery(session: AgentSession, options: {
	isCurrent?: () => boolean;
	isAlive?: () => boolean;
	onError?: (error: unknown) => void;
} = {}): void {
	scheduled.get(session)?.cancel();
	let cancelled = false;
	const file = session.sessionManager.getSessionFile();
	const message = pendingQuestions(session.messages)?.message;
	if (!message) return;
	const isCurrent = () => !cancelled && (options.isCurrent?.() ?? true)
		&& session.sessionManager.getSessionFile() === file;
	const timer = setTimeout(() => {
		if (!isCurrent() || pendingQuestions(session.messages)?.message !== message || session.isStreaming) return;
		void recoverQuestions(session, options.isAlive ?? isCurrent).catch((error) => options.onError?.(error));
	}, 0);
	timer.unref();
	scheduled.set(session, { cancel() { cancelled = true; clearTimeout(timer); } });
}

export function cancelQuestionRecovery(session: AgentSession): void {
	scheduled.get(session)?.cancel();
	scheduled.delete(session);
}

export async function recoverQuestions(session: AgentSession, isCurrent = () => true): Promise<boolean> {
	const pending = pendingQuestions(session.messages);
	if (!pending || session.isStreaming || !isCurrent()) return false;
	if (!session.agent.state.tools.some((tool) => tool.name === "question")) return false;
	const agent = session.agent;
	const adapter = agent as unknown as RecoveryAgent;
	const internals = session as unknown as RecoverySession;
	if (typeof adapter.runWithLifecycle !== "function" || typeof adapter.processEvents !== "function"
		|| typeof internals._emitAgentSettled !== "function") throw new Error("Question recovery is incompatible with this Pi SDK");
	const core = await (runner ??= loadToolRunner());
	// Loading the adapter is asynchronous: the user may have submitted/replaced meanwhile.
	if (!isCurrent() || session.isStreaming || pendingQuestions(session.messages)?.message !== pending.message) return false;
	internals._isAgentRunActive = true;
	internals._agentRunAbortRequested = false;
	internals._failedResponse = undefined;
	let terminated = false;
	try {
		await adapter.runWithLifecycle(async (signal) => {
			await adapter.processEvents({ type: "agent_start" });
			await adapter.processEvents({ type: "turn_start" });
			const toolResults: ToolResultMessage[] = [];
			for (const call of pending.calls) {
				if (signal.aborted || !isCurrent()) break;
				await adapter.processEvents({ type: "tool_execution_start", toolCallId: call.id, toolName: call.name, args: call.arguments });
				const execution = await core.runToolCall(call, {
					context: { messages: session.messages, tools: agent.state.tools }, assistantMessage: pending.message,
					tools: agent.state.tools, signal, beforeToolCall: agent.beforeToolCall, afterToolCall: agent.afterToolCall,
					onUpdate() {},
				});
				// A replacement/abort is interruption, not an answer to the old question.
				if (signal.aborted || !isCurrent()) break;
				await adapter.processEvents({ type: "tool_execution_end", toolCallId: call.id, toolName: call.name, result: execution.result, isError: execution.isError });
				const message: ToolResultMessage = { role: "toolResult", toolCallId: call.id, toolName: call.name,
					content: execution.result.content ?? [], details: execution.result.details,
					...(execution.result.usage ? { usage: execution.result.usage } : {}),
					isError: execution.isError, timestamp: Date.now() };
				await adapter.processEvents({ type: "message_start", message });
				await adapter.processEvents({ type: "message_end", message });
				toolResults.push(message);
				if (execution.result.terminate) { terminated = true; break; }
			}
			await adapter.processEvents({ type: "turn_end", message: pending.message, toolResults });
			await adapter.processEvents({ type: "agent_end", messages: toolResults });
		});
		if (terminated || !isCurrent() || internals._agentRunAbortRequested || pendingQuestions(session.messages)) return true;
		// Match AgentSession's normal post-run lifecycle (retry, compaction, queues,
		// before-settle extensions), without adding a synthetic user prompt.
		await agent.continue();
		while (isCurrent() && !internals._agentRunAbortRequested) {
			if (!await internals._handlePostAgentRun() && !await internals._runBeforeSettleBoundary()) break;
			if (!internals._agentRunAbortRequested) await agent.continue();
		}
	} finally {
		if (internals._agentRunAbortRequested) internals._finishCancelledRetry();
		internals._failedResponse = undefined;
		internals._runSystemPromptOptions = undefined;
		internals._flushPendingBashMessages();
		internals._flushPendingCustomMessages();
		await internals._emitAgentSettled();
	}
	return true;
}

async function loadToolRunner(): Promise<ToolRunner> {
	// Core is ESM-only and may be nested under the SDK, not a root dependency.
	const manifestPath = requireSdk.resolve("@earendil-works/pi-agent-core/package.json");
	const manifest = requireSdk(manifestPath) as { exports: { ".": { import: string } } };
	return import(new URL(manifest.exports["."].import, pathToFileURL(manifestPath)).href);
}

/** RPC has its own SDK instance; install before entering its RPC mode. */
export function installRpcQuestionRecovery(Session: { prototype: AgentSession }): void {
	const prototype = Session.prototype;
	const bind = prototype.bindExtensions;
	prototype.bindExtensions = async function (options) {
		cancelQuestionRecovery(this);
		await bind.call(this, options);
		scheduleQuestionRecovery(this, { onError: (error) => options?.uiContext?.notify(String(error), "error") });
	};
	const dispose = prototype.dispose;
	prototype.dispose = function () { cancelQuestionRecovery(this); dispose.call(this); };
}
