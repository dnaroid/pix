import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { once } from "node:events";

/**
 * Shared mock LLM server for end-to-end PTY tests.
 *
 * It stands up a real HTTP server that speaks both wire formats the pi-ai SDK
 * uses for the providers we register in `models.json`:
 *
 *   - POST /v1/chat/completions  -> openai-completions SSE
 *   - POST /v1/messages          -> anthropic-messages SSE
 *
 * Scripted responses are format-agnostic content segments; the server renders
 * them in whichever wire format the request demands. This lets a single mock
 * exercise the full pix stack (real binary in a PTY, real SDK parsing) against
 * text, reasoning/thinking, tool calls, and injected streaming failures.
 */

export type MockSegment =
	| { kind: "text"; text: string }
	| { kind: "thinking"; text: string; signature?: string }
	| { kind: "tool_use"; id?: string; name: string; input?: Record<string, unknown> | string };

export interface MockResponse {
	segments: MockSegment[];
	/**
	 * Inject a streaming failure. Without `midStream` the server replies with an
	 * HTTP error status before any SSE. With `midStream: true` it streams the
	 * first segment, then abruptly tears the connection down so pi-ai surfaces an
	 * abort/truncation error to the TUI.
	 */
	error?: { status?: number; message?: string; midStream?: boolean };
}

/** Backward-compatible with the original text-only mock: plain strings become a single text segment. */
export type MockScriptedResponse = string | MockResponse;

export interface MockModelOptions {
	/** Provider id used in models.json for the openai-completions provider. Default "pix-test". */
	openaiProviderId?: string;
	/** Provider id used in models.json for the anthropic-messages provider. Default "pix-test-anthropic". */
	anthropicProviderId?: string;
	/** Model id advertised under each provider. Default "mock". */
	modelId?: string;
	/** Size of each streamed text/argument chunk, in characters. Default 24. */
	chunkSize?: number;
	/**
	 * Delay between streamed chunks, in milliseconds. Default 0. Real streaming
	 * has inter-token latency; setting this > 0 makes mid-stream assertions (resize,
	 * abort, scroll-during-stream) deterministic by keeping the stream in flight
	 * long enough to observe it.
	 */
	chunkDelayMs?: number;
	/**
	 * Response to serve once the scripted queue is exhausted, instead of the
	 * generic default text. Useful when retries or extra turns consume more
	 * requests than you queued, so the recovery marker still arrives.
	 */
	defaultResponse?: MockScriptedResponse;
}

export interface MockModelRequest {
	api: "openai-completions" | "anthropic-messages";
	model: string;
	body: unknown;
}

const DEFAULT_CHUNK_SIZE = 24;

function asResponse(scripted: MockScriptedResponse): MockResponse {
	return typeof scripted === "string" ? { segments: [{ kind: "text", text: scripted }] } : scripted;
}

function resolveStopReason(segments: MockSegment[], fallback: "stop" | "tool_use" = "stop"): "stop" | "tool_use" {
	const last = segments[segments.length - 1];
	return last?.kind === "tool_use" ? "tool_use" : fallback;
}

export class MockModel {
	requestCount = 0;
	readonly requests: MockModelRequest[] = [];

	private readonly server: Server;
	private readonly queue: MockResponse[];
	private readonly resolvedDefault: MockResponse;

	private constructor(
		responses: MockScriptedResponse[],
		private readonly options: Required<MockModelOptions>,
	) {
		this.queue = responses.map(asResponse);
		this.resolvedDefault = asResponse(options.defaultResponse);
		this.server = createServer((request, response) => {
			void this.handleRequest(request, response);
		});
	}

	static async start(responses: MockScriptedResponse[], options: MockModelOptions = {}): Promise<MockModel> {
		const model = new MockModel(responses, {
			openaiProviderId: options.openaiProviderId ?? "pix-test",
			anthropicProviderId: options.anthropicProviderId ?? "pix-test-anthropic",
			modelId: options.modelId ?? "mock",
			chunkSize: options.chunkSize ?? DEFAULT_CHUNK_SIZE,
			chunkDelayMs: options.chunkDelayMs ?? 0,
			defaultResponse: options.defaultResponse ?? "default mocked response",
		});
		model.server.listen(0, "127.0.0.1");
		await once(model.server, "listening");
		return model;
	}

	get openaiModelRef(): string {
		return `${this.options.openaiProviderId}/${this.options.modelId}`;
	}

	get anthropicModelRef(): string {
		return `${this.options.anthropicProviderId}/${this.options.modelId}`;
	}

	baseUrl(): string {
		const address = this.server.address();
		if (!address || typeof address === "string") throw new Error("Mock server is not listening");
		return `http://127.0.0.1:${address.port}`;
	}

	modelsJson(): unknown {
		const model = {
			id: this.options.modelId,
			name: "Mock Model",
			reasoning: true,
			input: ["text"],
			contextWindow: 128000,
			maxTokens: 8192,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		};
		return {
			providers: {
				[this.options.openaiProviderId]: {
					name: "Pix OpenAI Test",
					baseUrl: `${this.baseUrl()}/v1`,
					api: "openai-completions",
					apiKey: "test-key",
					compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
					models: [model],
				},
				[this.options.anthropicProviderId]: {
					name: "Pix Anthropic Test",
					baseUrl: this.baseUrl(),
					api: "anthropic-messages",
					apiKey: "test-key",
					compat: { supportsReasoningEffort: false },
					models: [model],
				},
			},
		};
	}

	async stop(): Promise<void> {
		this.server.closeAllConnections();
		await new Promise<void>((resolve) => this.server.close(() => resolve()));
	}

	private async handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
		const body = await this.drain(request);
		if (request.method !== "POST") {
			response.writeHead(404).end();
			return;
		}

		const parsed = parseRequestBody(body);
		const api = request.url === "/v1/messages" ? "anthropic-messages" : "openai-completions";
		this.requestCount += 1;
		this.requests.push({ api, model: parsed?.model ?? this.options.modelId, body: parsed });

		const next = this.queue.shift();
		const scripted = next ?? this.resolvedDefault;

		if (scripted.error && !scripted.error.midStream) {
			const status = scripted.error.status ?? 500;
			writeApiError(response, api, status, scripted.error.message ?? "mock error");
			response.end();
			return;
		}

		if (api === "anthropic-messages") {
			await this.streamAnthropic(response, scripted);
		} else {
			await this.streamOpenAi(response, scripted);
		}
	}

	private async drain(request: IncomingMessage): Promise<string> {
		let body = "";
		for await (const chunk of request) body += chunk.toString("utf8");
		return body;
	}

	private async streamOpenAi(response: ServerResponse, scripted: MockResponse): Promise<void> {
		response.writeHead(200, {
			"content-type": "text/event-stream; charset=utf-8",
			"cache-control": "no-cache",
			connection: "keep-alive",
		});

		this.writeOpenAiChunk(response, { role: "assistant" });

		// OpenAI parallel tool calls are distinguished by a unique delta index per
		// call; reusing index 0 would make pi-ai dedupe the second call into the
		// first block. Assign an incrementing index per tool_use segment.
		let toolIndex = 0;
		for (const segment of scripted.segments) {
			if (segment.kind === "text") {
				for (const piece of chunkText(segment.text, this.options.chunkSize)) {
					this.writeOpenAiChunk(response, { content: piece });
					await this.delay();
				}
			} else if (segment.kind === "thinking") {
				for (const piece of chunkText(segment.text, this.options.chunkSize)) {
					this.writeOpenAiChunk(response, { reasoning_content: piece });
					await this.delay();
				}
			} else {
				const index = toolIndex;
				toolIndex += 1;
				const id = segment.id ?? `call_${this.requestCount}_${index}`;
				this.writeOpenAiChunk(response, {}, {
					index,
					id,
					type: "function",
					function: { name: segment.name, arguments: "" },
				});
				await this.delay();
				const json = typeof segment.input === "string" ? segment.input : JSON.stringify(segment.input ?? {});
				for (const piece of chunkText(json, this.options.chunkSize)) {
					this.writeOpenAiChunk(response, {}, {
						index,
						function: { arguments: piece },
					});
					await this.delay();
				}
			}
			// Flush partial bytes before the connection drops: anthropic-messages
			// pi-ai still reports the missing message_stop as a stream error, while
			// openai-completions ends the turn early. Either way the TUI must survive.
			if (scripted.error?.midStream) {
				response.end();
				return;
			}
		}

		const finishReason = resolveStopReason(scripted.segments) === "tool_use" ? "tool_calls" : "stop";
		response.write(`data: ${JSON.stringify({
			id: "chatcmpl-pix-test",
			object: "chat.completion.chunk",
			created: 0,
			model: this.options.modelId,
			choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
			usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
		})}\n\n`);
		response.write("data: [DONE]\n\n");
		response.end();
	}

	private async streamAnthropic(response: ServerResponse, scripted: MockResponse): Promise<void> {
		response.writeHead(200, {
			"content-type": "text/event-stream; charset=utf-8",
			"cache-control": "no-cache",
			connection: "keep-alive",
		});

		const messageId = `msg_pix_test_${this.requestCount}`;
		this.writeAnthropicEvent(response, "message_start", {
			type: "message_start",
			message: {
				id: messageId,
				type: "message",
				role: "assistant",
				content: [],
				model: this.options.modelId,
				stop_reason: null,
				usage: { input_tokens: 1, output_tokens: 0 },
			},
		});

		for (const [index, segment] of scripted.segments.entries()) {
			if (segment.kind === "text") {
				this.writeAnthropicEvent(response, "content_block_start", {
					type: "content_block_start",
					index,
					content_block: { type: "text", text: "" },
				});
				for (const piece of chunkText(segment.text, this.options.chunkSize)) {
					this.writeAnthropicEvent(response, "content_block_delta", {
						type: "content_block_delta",
						index,
						delta: { type: "text_delta", text: piece },
					});
					await this.delay();
				}
				this.writeAnthropicEvent(response, "content_block_stop", { type: "content_block_stop", index });
			} else if (segment.kind === "thinking") {
				this.writeAnthropicEvent(response, "content_block_start", {
					type: "content_block_start",
					index,
					content_block: { type: "thinking", thinking: "" },
				});
				for (const piece of chunkText(segment.text, this.options.chunkSize)) {
					this.writeAnthropicEvent(response, "content_block_delta", {
						type: "content_block_delta",
						index,
						delta: { type: "thinking_delta", thinking: piece },
					});
					await this.delay();
				}
				if (segment.signature) {
					this.writeAnthropicEvent(response, "content_block_delta", {
						type: "content_block_delta",
						index,
						delta: { type: "signature_delta", signature: segment.signature },
					});
				}
				this.writeAnthropicEvent(response, "content_block_stop", { type: "content_block_stop", index });
			} else {
				const id = segment.id ?? `toolu_pix_test_${this.requestCount}`;
				this.writeAnthropicEvent(response, "content_block_start", {
					type: "content_block_start",
					index,
					content_block: { type: "tool_use", id, name: segment.name, input: {} },
				});
				await this.delay();
				const json = typeof segment.input === "string" ? segment.input : JSON.stringify(segment.input ?? {});
				for (const piece of chunkText(json, this.options.chunkSize)) {
					this.writeAnthropicEvent(response, "content_block_delta", {
						type: "content_block_delta",
						index,
						delta: { type: "input_json_delta", partial_json: piece },
					});
					await this.delay();
				}
				this.writeAnthropicEvent(response, "content_block_stop", { type: "content_block_stop", index });
			}
		}

		if (scripted.error?.midStream) {
			response.end();
			return;
		}

		const stopReason = resolveStopReason(scripted.segments) === "tool_use" ? "tool_use" : "end_turn";
		this.writeAnthropicEvent(response, "message_delta", {
			type: "message_delta",
			delta: { stop_reason: stopReason, stop_sequence: null },
			usage: { output_tokens: 1 },
		});
		this.writeAnthropicEvent(response, "message_stop", { type: "message_stop" });
		response.end();
	}

	private writeOpenAiChunk(
		response: ServerResponse,
		delta: Record<string, unknown>,
		toolCall?: Record<string, unknown>,
	): void {
		const merged: Record<string, unknown> = { ...delta };
		if (toolCall) merged.tool_calls = [toolCall];
		response.write(`data: ${JSON.stringify({
			id: "chatcmpl-pix-test",
			object: "chat.completion.chunk",
			created: 0,
			model: this.options.modelId,
			choices: [{ index: 0, delta: merged, finish_reason: null }],
		})}\n\n`);
	}

	private writeAnthropicEvent(response: ServerResponse, event: string, payload: unknown): void {
		response.write(`event: ${event}\n`);
		response.write(`data: ${JSON.stringify(payload)}\n\n`);
	}

	private async delay(): Promise<void> {
		if (this.options.chunkDelayMs <= 0) return;
		await new Promise((resolve) => setTimeout(resolve, this.options.chunkDelayMs));
	}
}

function chunkText(text: string, size: number): string[] {
	if (text.length === 0) return [""];
	const chunks: string[] = [];
	for (let index = 0; index < text.length; index += size) chunks.push(text.slice(index, index + size));
	return chunks;
}

function parseRequestBody(body: string): { model?: string; messages?: unknown[]; tools?: unknown[] } | undefined {
	if (!body) return undefined;
	try {
		const parsed = JSON.parse(body) as { model?: string; messages?: unknown[]; tools?: unknown[] };
		return parsed;
	} catch {
		return undefined;
	}
}

function writeApiError(response: ServerResponse, api: "openai-completions" | "anthropic-messages", status: number, message: string): void {
	if (api === "anthropic-messages") {
		response.writeHead(status, { "content-type": "application/json" });
		response.write(JSON.stringify({
			type: "error",
			error: { type: mapAnthropicErrorType(status), message },
		}));
		return;
	}
	response.writeHead(status, { "content-type": "application/json" });
	response.write(JSON.stringify({ error: { message, type: "mock_error", code: null } }));
}

function mapAnthropicErrorType(status: number): string {
	if (status === 429) return "rate_limit_error";
	if (status >= 500) return "api_error";
	if (status === 401 || status === 403) return "authentication_error";
	return "invalid_request_error";
}

/** Assertion helper kept here so PTY tests share one wait loop. */
export async function waitFor(predicate: () => boolean, message: () => string, timeoutMs = 10_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	assert.fail(message());
}
