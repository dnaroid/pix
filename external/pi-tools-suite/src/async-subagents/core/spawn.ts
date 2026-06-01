import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { selectSuitableToolsForModel } from "../../lib/tool-args.js";
import { validateBasename } from "./paths.js";
import { getPiInvocation } from "./pi-invocation.js";
import { writePromptFile } from "./prompt.js";
import { getAgentSessionDir, SUBAGENT_PARENT_SESSION_FILE, SUBAGENT_RETURN_SESSION_FILE, SUBAGENT_SESSION_FILE, writeParentSessionLink, writeSessionFileLink } from "./sessions.js";
import { getAgentState } from "./state.js";
import { writeStructuredResult } from "./structured-result.js";
import { createBoundedFileWriter, createDeferredFileWriter, resolveSubagentLogLimits } from "./log-limits.js";
import { filterSubagentTools } from "./tool-guard.js";
import type { AgentCompletionHandler, AgentTask, RpcEventHandler, RpcEventRecord, SpawnedAgent } from "./types.js";
import { isRecord, isoNow, serializeJsonLine } from "./utils.js";

export interface SpawnAgentOptions {
	parentSession?: string;
	timeoutMs?: number;
	maxResultBytes?: number;
}

export const DEFAULT_AGENT_TIMEOUT_MS = 30 * 60 * 1000;
const AGENT_TIMEOUT_EXIT_CODE = 124;
const AGENT_TIMEOUT_KILL_GRACE_MS = 5_000;

export function shouldPersistSubagentSessions(env: NodeJS.ProcessEnv = process.env): boolean {
	return isTruthyEnv(env.ASYNC_SUBAGENTS_ENABLE_SESSIONS);
}

export function spawnAgent(
	runDir: string,
	task: AgentTask,
	cwd: string,
	extraArgs: string[] = [],
	onRpcEvent?: RpcEventHandler,
	onComplete?: AgentCompletionHandler,
	options: SpawnAgentOptions = {},
): SpawnedAgent {
	validateBasename(task.id, "task.id");
	const agentDir = path.join(runDir, task.id);
	fs.mkdirSync(agentDir, { recursive: true });

	// Clean previous state when reusing a run directory/agent id.
	for (const f of [
		"exit_code",
		"finished_at",
		"result.md",
		"result.json",
		"events.jsonl",
		"stderr.log",
		"session_dir",
		"image_paths",
		SUBAGENT_SESSION_FILE,
		SUBAGENT_PARENT_SESSION_FILE,
		SUBAGENT_RETURN_SESSION_FILE,
		"timeout_ms",
		"timed_out_at",
		"stop_requested",
		"stop_signal",
		"retry_pending",
		"next_retry_at",
	]) {
		try {
			fs.unlinkSync(path.join(agentDir, f));
		} catch {
			/* ignore */
		}
	}
	fs.rmSync(getAgentSessionDir(agentDir), { recursive: true, force: true });

	// Write prompt file (also to prompts/ dir for planned status)
	const promptPath = writePromptFile(runDir, task);
	fs.copyFileSync(promptPath, path.join(agentDir, "prompt.md"));

	// Build pi args. By default sub-agents use the parent/default model.
	// E2E/live deployments can pin the real model explicitly through env so
	// detached subprocesses do not depend on persisted local pi settings.
	const persistSessions = shouldPersistSubagentSessions();
	const sessionDir = persistSessions ? getAgentSessionDir(agentDir) : undefined;
	if (sessionDir) fs.mkdirSync(sessionDir, { recursive: true });
	const piArgs: string[] = ["--mode", "rpc"];
	if (sessionDir) piArgs.push("--session-dir", sessionDir);
	else piArgs.push("--no-session");
	piArgs.push("--no-extensions");
	piArgs.push("--extension", getModelToolsExtensionPath());
	const envModel = task.model || getEnvModel();
	if (envModel) piArgs.push("--model", envModel);
	const selectedTools = task.tools ? filterSubagentTools(selectSuitableToolsForModel(envModel, task.tools)) : undefined;
	if (selectedTools) {
		if (selectedTools.length > 0) piArgs.push("--tools", selectedTools.join(","));
		else piArgs.push("--no-tools");
	}
	if (task.thinking) piArgs.push("--thinking", task.thinking);

	// User-supplied extra args (e.g. --thinking high)
	piArgs.push(...extraArgs);
	// Keep recursive/interactive parent-only tools disabled even if explicit
	// sub-agent extraArgs load additional extensions or override --tools.
	piArgs.push("--extension", getSubagentToolGuardExtensionPath());

	// Read prompt content for stdin
	const promptContent = fs.readFileSync(promptPath, "utf-8");
	const promptImages = task.imagePaths && task.imagePaths.length > 0 ? readPromptImages(task.imagePaths, cwd) : undefined;

	// Write metadata
	fs.writeFileSync(path.join(agentDir, "project_cwd"), cwd, "utf-8");
	fs.writeFileSync(path.join(agentDir, "pi_args"), piArgs.join("\n"), "utf-8");
	if (sessionDir) fs.writeFileSync(path.join(agentDir, "session_dir"), sessionDir, "utf-8");
	writeParentSessionLink(agentDir, options.parentSession);
	if (task.subagentType) fs.writeFileSync(path.join(agentDir, "subagent_type"), task.subagentType, "utf-8");
	if (task.model) fs.writeFileSync(path.join(agentDir, "model"), task.model, "utf-8");
	if (task.imagePaths && task.imagePaths.length > 0) fs.writeFileSync(path.join(agentDir, "image_paths"), task.imagePaths.join("\n"), "utf-8");
	fs.writeFileSync(path.join(agentDir, "started_at"), isoNow(), "utf-8");

	const transcriptFile = path.join(agentDir, "events.jsonl");
	const stderrFile = path.join(agentDir, "stderr.log");
	const logLimits = resolveSubagentLogLimits();

	const invocation = getPiInvocation(piArgs);
	const stderrStream = createDeferredFileWriter(stderrFile, logLimits.stderrMaxBytes, "stderr.log");
	const transcriptStream = createBoundedFileWriter(transcriptFile, logLimits.eventsMaxBytes, "events.jsonl");

	const proc = spawn(invocation.command, invocation.args, {
		cwd,
		env: subagentEnvironment(process.env),
		stdio: ["pipe", "pipe", "pipe"],
	});
	let completedFromAgentEnd = false;
	let completionNotified = false;
	let lastAssistantResult = "";
	let lastAgentEndError = "";
	let timedOut = false;
	let shouldKeepStderr = false;
	let timeoutTimer: NodeJS.Timeout | undefined;
	let timeoutKillTimer: NodeJS.Timeout | undefined;
	const suppressedRpcEventCounts = new Map<string, number>();

	const notifyComplete = (exitCode: number) => {
		if (completionNotified) return;
		if (exitCode !== 0) shouldKeepStderr = true;
		completionNotified = true;
		if (timeoutTimer) clearTimeout(timeoutTimer);
		if (timeoutKillTimer) clearTimeout(timeoutKillTimer);
		if (!fs.existsSync(agentDir)) {
			onComplete?.({
				runDir,
				agentId: task.id,
				agentDir,
				exitCode,
				state: { id: task.id, status: exitCode === 0 ? "done" : "failed", exitCode },
			});
			return;
		}
		fs.writeFileSync(
			path.join(agentDir, "exit_code"),
			fs.existsSync(path.join(agentDir, "stop_requested")) ? "stopped" : String(exitCode),
			"utf-8",
		);
		fs.writeFileSync(path.join(agentDir, "finished_at"), isoNow(), "utf-8");
		const state = getAgentState(runDir, task.id) ?? {
			id: task.id,
			status: exitCode === 0 ? "done" : "failed",
			exitCode,
		};
		// Write structured result.json alongside result.md
		try {
			writeStructuredResult({
				agentDir,
				agentId: task.id,
				state,
				subagentType: task.subagentType,
				model: task.model,
				maxResultBytes: options.maxResultBytes,
			});
		} catch {
			/* non-critical: do not block completion */
		}
		onComplete?.({ runDir, agentId: task.id, agentDir, exitCode, state });
	};

	const timeoutMs = options.timeoutMs ?? DEFAULT_AGENT_TIMEOUT_MS;
	if (timeoutMs > 0) {
		timeoutTimer = setTimeout(() => {
			if (completionNotified) return;
			timedOut = true;
			const timeoutMessage = `Sub-agent timed out after ${Math.round(timeoutMs / 1000)} seconds.`;
			if (fs.existsSync(agentDir)) {
				fs.writeFileSync(path.join(agentDir, "timeout_ms"), String(timeoutMs), "utf-8");
				fs.writeFileSync(path.join(agentDir, "timed_out_at"), isoNow(), "utf-8");
				if (!fs.existsSync(path.join(agentDir, "result.md")))
					fs.writeFileSync(path.join(agentDir, "result.md"), timeoutMessage, "utf-8");
				stderrStream.write(`${timeoutMessage}\n`);
			}
			try {
				proc.kill("SIGTERM");
			} catch {
				/* process may have exited between the timer and signal */
			}
			timeoutKillTimer = setTimeout(() => {
				if (completionNotified) return;
				try {
					proc.kill("SIGKILL");
				} catch {
					/* process may have exited after SIGTERM */
				}
			}, AGENT_TIMEOUT_KILL_GRACE_MS);
			timeoutKillTimer.unref?.();
		}, timeoutMs);
		timeoutTimer.unref?.();
	}

	proc.stderr.on("data", (chunk) => stderrStream.write(chunk));
	attachJsonlLineReader(proc.stdout, (line) => {
		const suppressedEventType = onRpcEvent ? undefined : suppressedRpcEventType(line);
		if (suppressedEventType) {
			suppressedRpcEventCounts.set(suppressedEventType, (suppressedRpcEventCounts.get(suppressedEventType) ?? 0) + 1);
			return;
		}
		try {
			const event = JSON.parse(line) as RpcEventRecord;
			const storedEvent = compactRpcEventForTranscript(event, Buffer.byteLength(line, "utf8"));
			if (storedEvent) transcriptStream.write(serializeJsonLine(storedEvent));
			onRpcEvent?.(event);
			const sessionFile = extractSessionFileFromEvent(event);
			if (sessionFile) writeSessionFileLink(agentDir, sessionFile);
			const assistantResult = extractAssistantResultFromEvent(event);
			if (assistantResult.trim()) lastAssistantResult = assistantResult;
			const messageEndError = extractMessageEndErrorMessage(event);
			if (messageEndError) lastAgentEndError = messageEndError;
			if (event.type === "response" && event.command === "prompt" && event.success === false) {
				const errorText = typeof event.error === "string" ? event.error : "RPC prompt failed";
				fs.writeFileSync(path.join(agentDir, "result.md"), errorText, "utf-8");
				notifyComplete(1);
				proc.kill("SIGTERM");
				return;
			}
			if (event.type === "agent_end") {
				const errorMessage = extractAgentEndErrorMessage(event);
				if (errorMessage) {
					lastAgentEndError = errorMessage;
					return;
				}
				completedFromAgentEnd = true;
				const result = extractAgentEndResult(event);
				if (result.trim())
					fs.writeFileSync(path.join(agentDir, "result.md"), result, "utf-8");
				notifyComplete(0);
				proc.kill("SIGTERM");
			}
		} catch (error) {
			stderrStream.write(`Invalid RPC JSON line: ${String(error)}\n${previewLine(line)}\n`);
			transcriptStream.write(serializeJsonLine({ type: "invalid_json", bytes: Buffer.byteLength(line, "utf8") }));
		}
	}, {
		maxLineChars: logLimits.rpcEventLineMaxChars,
		onLineTooLongStart: (linePrefix) => {
			const suppressedEventType = onRpcEvent ? undefined : suppressedRpcEventType(linePrefix);
			if (suppressedEventType) {
				suppressedRpcEventCounts.set(suppressedEventType, (suppressedRpcEventCounts.get(suppressedEventType) ?? 0) + 1);
				return true;
			}
			if (!onRpcEvent && isAgentEndLine(linePrefix)) {
				transcriptStream.write(serializeJsonLine({ type: "agent_end", oversized: true, bufferedChars: linePrefix.length }));
				if (lastAgentEndError) {
					fs.writeFileSync(path.join(agentDir, "result.md"), lastAgentEndError, "utf-8");
				} else if (lastAssistantResult.trim()) {
					completedFromAgentEnd = true;
					fs.writeFileSync(path.join(agentDir, "result.md"), lastAssistantResult.trim(), "utf-8");
				} else {
					lastAgentEndError = "Sub-agent produced an oversized agent_end RPC event before a final result could be captured.";
					fs.writeFileSync(path.join(agentDir, "result.md"), lastAgentEndError, "utf-8");
				}
				proc.kill("SIGTERM");
				return true;
			}
			return false;
		},
		onLineTooLong: (lineChars) => {
			const message = `RPC JSON line exceeded ${logLimits.rpcEventLineMaxChars} chars; dropped oversized event (${lineChars} chars).`;
			stderrStream.write(`${message}\n`);
			transcriptStream.write(serializeJsonLine({ type: "oversized_rpc_event", chars: lineChars }));
		},
	});

	proc.once("exit", (code, signal) => {
		writeSuppressedRpcEventSummary(transcriptStream, suppressedRpcEventCounts);
		const exitCode = resolveAgentExitCode({
			timedOut,
			completedFromAgentEnd,
			lastAgentEndError,
			code,
			signal,
		});
		if (fs.existsSync(agentDir)) {
			if (exitCode === 0 && !fs.existsSync(path.join(agentDir, "result.md")) && lastAssistantResult.trim()) {
				fs.writeFileSync(path.join(agentDir, "result.md"), lastAssistantResult.trim(), "utf-8");
			} else if (exitCode !== 0 && !fs.existsSync(path.join(agentDir, "result.md")) && lastAgentEndError) {
				fs.writeFileSync(path.join(agentDir, "result.md"), lastAgentEndError, "utf-8");
			}
		}
		if (shouldKeepStderr || exitCode !== 0 || logLimits.debugLogs) stderrStream.flush();
		else stderrStream.discard();
		transcriptStream.end();
		notifyComplete(exitCode);
	});

	proc.once("error", (error) => {
		const message = String(error);
		stderrStream.write(`${message}\n`);
		shouldKeepStderr = true;
		if (fs.existsSync(agentDir) && !fs.existsSync(path.join(agentDir, "result.md"))) {
			fs.writeFileSync(path.join(agentDir, "result.md"), message, "utf-8");
		}
		stderrStream.flush();
		transcriptStream.end();
		notifyComplete(1);
	});

	proc.stdin.write(
		serializeJsonLine({
			id: "sub_get_state",
			type: "get_state",
		}),
	);
	proc.stdin.write(
		serializeJsonLine({
			id: "sub_prompt",
			type: "prompt",
			message: promptContent,
			...(promptImages ? { images: promptImages } : {}),
		}),
	);

	const pid = proc.pid!;
	fs.writeFileSync(path.join(agentDir, "pid"), String(pid), "utf-8");

	return { pid, agentDir, process: proc };
}

function getModelToolsExtensionPath(): string {
	return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "model-tools", "index.ts");
}

function getSubagentToolGuardExtensionPath(): string {
	return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "tool-guard.ts");
}

function resolveAgentExitCode(options: {
	timedOut: boolean;
	completedFromAgentEnd: boolean;
	lastAgentEndError: string;
	code: number | null;
	signal: NodeJS.Signals | null;
}): number {
	if (options.timedOut) return AGENT_TIMEOUT_EXIT_CODE;
	if (options.completedFromAgentEnd) return 0;
	if (options.lastAgentEndError) return 1;
	if (typeof options.code === "number") return options.code;
	if (options.signal) return 128;
	return 1;
}

function readPromptImages(imagePaths: string[], cwd: string): Array<{ type: "image"; data: string; mimeType: string }> {
	return imagePaths.map((imagePath) => {
		const resolved = resolveImagePath(imagePath, cwd);
		const mimeType = imageMimeType(resolved);
		if (!mimeType) throw new Error(`Unsupported image type for sub-agent attachment: ${imagePath}`);
		return {
			type: "image" as const,
			data: fs.readFileSync(resolved).toString("base64"),
			mimeType,
		};
	});
}

function resolveImagePath(imagePath: string, cwd: string): string {
	const normalized = imagePath.startsWith("@") ? imagePath.slice(1) : imagePath;
	return path.resolve(cwd, normalized);
}

function imageMimeType(filePath: string): string | undefined {
	switch (path.extname(filePath).toLowerCase()) {
		case ".jpg":
		case ".jpeg":
			return "image/jpeg";
		case ".png":
			return "image/png";
		case ".gif":
			return "image/gif";
		case ".webp":
			return "image/webp";
		default:
			return undefined;
	}
}

function extractSessionFileFromEvent(event: RpcEventRecord): string | undefined {
	if (event.type !== "response" || event.command !== "get_state" || event.success !== true)
		return undefined;
	if (!isRecord(event.data)) return undefined;
	const sessionFile = event.data.sessionFile;
	return typeof sessionFile === "string" && sessionFile.trim() ? sessionFile : undefined;
}

function attachJsonlLineReader(
	stream: NodeJS.ReadableStream,
	onLine: (line: string) => void,
	options: {
		maxLineChars?: number;
		onLineTooLongStart?: (linePrefix: string) => boolean;
		onLineTooLong?: (lineChars: number) => void;
	} = {},
): void {
	let buffer = "";
	let droppingOversizedLine: false | "handled" | "report" = false;
	let droppedChars = 0;
	const maxLineChars = options.maxLineChars && options.maxLineChars > 0 ? options.maxLineChars : undefined;

	stream.on("data", (chunk: string | Buffer) => {
		buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");

		while (true) {
			const newlineIndex = buffer.indexOf("\n");
			if (newlineIndex === -1) {
				if (maxLineChars !== undefined && buffer.length > maxLineChars) {
					droppingOversizedLine = options.onLineTooLongStart?.(buffer) ? "handled" : "report";
					droppedChars += buffer.length;
					buffer = "";
				}
				return;
			}

			const line = buffer.slice(0, newlineIndex);
			buffer = buffer.slice(newlineIndex + 1);
			const normalized = line.endsWith("\r") ? line.slice(0, -1) : line;
			if (droppingOversizedLine) {
				droppedChars += normalized.length;
				if (droppingOversizedLine === "report") options.onLineTooLong?.(droppedChars);
				droppingOversizedLine = false;
				droppedChars = 0;
				continue;
			}
			if (maxLineChars !== undefined && normalized.length > maxLineChars) {
				if (!options.onLineTooLongStart?.(normalized)) options.onLineTooLong?.(normalized.length);
				continue;
			}
			onLine(normalized);
		}
	});

	stream.on("end", () => {
		if (droppingOversizedLine) {
			droppedChars += buffer.length;
			if (droppingOversizedLine === "report") options.onLineTooLong?.(droppedChars);
			buffer = "";
			droppingOversizedLine = false;
			droppedChars = 0;
			return;
		}
		if (buffer.length > 0) {
			const normalized = buffer.endsWith("\r") ? buffer.slice(0, -1) : buffer;
			if (maxLineChars !== undefined && normalized.length > maxLineChars) {
				if (!options.onLineTooLongStart?.(normalized)) options.onLineTooLong?.(normalized.length);
			} else {
				onLine(normalized);
			}
			buffer = "";
		}
	});
}

function compactRpcEventForTranscript(event: RpcEventRecord, originalBytes: number): RpcEventRecord | undefined {
	if (event.type === "message_update" || event.type === "tool_execution_update") return undefined;
	if (event.type === "response") {
		return stripUndefined({
			type: event.type,
			command: typeof event.command === "string" ? event.command : undefined,
			success: typeof event.success === "boolean" ? event.success : undefined,
			error: typeof event.error === "string" ? previewLine(event.error) : undefined,
			bytes: originalBytes,
		});
	}
	if (event.type === "agent_end") {
		return {
			type: event.type,
			messageCount: Array.isArray(event.messages) ? event.messages.length : 0,
			bytes: originalBytes,
		};
	}
	if (event.type === "message_end") {
		return stripUndefined({
			type: event.type,
			role: isRecord(event.message) && typeof event.message.role === "string" ? event.message.role : undefined,
			stopReason: isRecord(event.message) && typeof event.message.stopReason === "string" ? event.message.stopReason : undefined,
			bytes: originalBytes,
		});
	}
	if (event.type === "turn_end") {
		return {
			type: event.type,
			toolResultCount: Array.isArray(event.toolResults) ? event.toolResults.length : 0,
			bytes: originalBytes,
		};
	}
	if (event.type === "tool_execution_start" || event.type === "tool_execution_end") {
		return stripUndefined({
			type: event.type,
			toolName: typeof event.toolName === "string" ? event.toolName : undefined,
			toolCallId: typeof event.toolCallId === "string" ? event.toolCallId : undefined,
			bytes: originalBytes,
		});
	}
	return { type: event.type, bytes: originalBytes };
}

function suppressedRpcEventType(line: string): string | undefined {
	if (line.includes('"type":"message_update"') || line.includes('"type": "message_update"')) return "message_update";
	if (line.includes('"type":"tool_execution_update"') || line.includes('"type": "tool_execution_update"')) return "tool_execution_update";
	return undefined;
}

function isAgentEndLine(line: string): boolean {
	return line.includes('"type":"agent_end"') || line.includes('"type": "agent_end"');
}

function writeSuppressedRpcEventSummary(transcriptStream: { write(chunk: string | Buffer): void }, counts: Map<string, number>): void {
	for (const [eventType, count] of counts) {
		if (count > 0) transcriptStream.write(serializeJsonLine({ type: "suppressed_rpc_events", eventType, count }));
	}
}

function previewLine(text: string, maxChars = 4096): string {
	return text.length <= maxChars ? text : `${text.slice(0, maxChars)}… [truncated ${text.length - maxChars} chars]`;
}

function stripUndefined(record: RpcEventRecord): RpcEventRecord {
	for (const key of Object.keys(record)) {
		if (record[key] === undefined) delete record[key];
	}
	return record;
}

function extractAgentEndErrorMessage(event: RpcEventRecord): string {
	const messages = Array.isArray(event.messages) ? event.messages : [];
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		const errorMessage = extractAssistantErrorMessage(message);
		if (errorMessage) return errorMessage;
		if (isRecord(message) && message.role === "assistant") return "";
	}
	return "";
}

function extractMessageEndErrorMessage(event: RpcEventRecord): string {
	if (event.type !== "message_end") return "";
	return extractAssistantErrorMessage(event.message);
}

function extractAssistantErrorMessage(message: unknown): string {
	if (!isRecord(message) || message.role !== "assistant" || message.stopReason !== "error") return "";
	return typeof message.errorMessage === "string" && message.errorMessage.trim()
		? message.errorMessage.trim()
		: "Sub-agent ended with an error.";
}

function extractAgentEndResult(event: RpcEventRecord): string {
	const messages = Array.isArray(event.messages) ? event.messages : [];
	const parts: string[] = [];

	for (const message of messages) {
		const text = extractAssistantMessageText(message);
		if (text) parts.push(text);
	}

	return parts.join("\n\n").trim();
}

function extractAssistantResultFromEvent(event: RpcEventRecord): string {
	const parts: string[] = [];
	if (isRecord(event.message)) {
		const text = extractAssistantMessageText(event.message);
		if (text) parts.push(text);
	}
	if (isRecord(event.assistantMessageEvent)) {
		const partial = event.assistantMessageEvent.partial;
		if (isRecord(partial)) {
			const text = extractAssistantMessageText(partial);
			if (text) parts.push(text);
		}
	}
	return parts.join("\n\n").trim();
}

function extractAssistantMessageText(message: unknown): string {
	if (!isRecord(message)) return "";
	if (message.role !== "assistant") return "";
	const content = message.content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const item of content) {
		if (!isRecord(item)) continue;
		if (item.type === "text" && typeof item.text === "string")
			parts.push(item.text);
	}
	return parts.join("\n\n").trim();
}

function getEnvModel(): string | undefined {
	const value = process.env.ASYNC_SUBAGENTS_MODEL || process.env.PI_SUBAGENTS_MODEL;
	const trimmed = value?.trim();
	return trimmed ? trimmed : undefined;
}

function subagentEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	return {
		...env,
		PI_MODEL_SUITABLE_TOOLS_PRESERVE_SELECTION: "1",
		PI_TERMINAL_BELL_DISABLED: "1",
		PI_TOOLS_SUITE_DISABLED_MODULES: appendEnvList(env.PI_TOOLS_SUITE_DISABLED_MODULES, [
			"async-subagents",
			"question",
			"terminal-bell",
		]),
	};
}

function appendEnvList(value: string | undefined, items: readonly string[]): string {
	const existing = value?.trim();
	return existing ? `${existing},${items.join(",")}` : items.join(",");
}

function isTruthyEnv(value: string | undefined): boolean {
	return /^(1|true|yes|on)$/i.test(value?.trim() ?? "");
}
