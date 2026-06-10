import { spawn } from "node:child_process";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, truncateHead } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { WEB_SEARCH_TOOL_DESCRIPTIONS } from "../tool-descriptions";

interface SearchResult {
	title: string;
	url: string;
	content: string;
}

interface SearchResponse {
	results: SearchResult[];
}

interface FetchResponse {
	title: string;
	content: string;
	links?: string[];
}

type Operation = "Search" | "Fetch";

class OllamaEndpointUnavailableError extends Error {
	constructor(message: string, readonly status: number) {
		super(message);
		this.name = "OllamaEndpointUnavailableError";
	}
}

const DEFAULT_OLLAMA_HOST = "http://localhost:11434";
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const MAX_REQUEST_TIMEOUT_MS = 120_000;
const REQUEST_TIMEOUT_ENV = "PI_WEB_SEARCH_TIMEOUT_MS";
const OLLAMA_STARTUP_TIMEOUT_ENV = "PI_WEB_SEARCH_OLLAMA_STARTUP_TIMEOUT_MS";
const DEFAULT_OLLAMA_STARTUP_TIMEOUT_MS = 30_000;
const MAX_ERROR_BODY_CHARS = 1_200;
const STARTED_OLLAMA_PROCESSES = new Set<string>();

function normalizeOllamaHost(host: string | undefined): string {
	const trimmed = host?.trim();
	if (!trimmed) return DEFAULT_OLLAMA_HOST;
	return /^https?:\/\//i.test(trimmed) ? trimmed.replace(/\/+$/, "") : `http://${trimmed.replace(/\/+$/, "")}`;
}

function getOllamaHost(): string {
	return normalizeOllamaHost(process.env.OLLAMA_HOST);
}

function parseTimeoutMs(value: unknown, source: string): number {
	const timeoutMs = typeof value === "string" ? Number(value.trim()) : value;
	if (!Number.isFinite(timeoutMs) || !Number.isInteger(timeoutMs) || (timeoutMs as number) < 1 || (timeoutMs as number) > MAX_REQUEST_TIMEOUT_MS) {
		throw new Error(`${source} must be an integer between 1 and ${MAX_REQUEST_TIMEOUT_MS} milliseconds.`);
	}
	return timeoutMs as number;
}

function resolveRequestTimeoutMs(timeoutMs: number | undefined): number {
	if (timeoutMs !== undefined) return parseTimeoutMs(timeoutMs, "timeout_ms");

	const envTimeout = process.env[REQUEST_TIMEOUT_ENV]?.trim();
	if (envTimeout) return parseTimeoutMs(envTimeout, REQUEST_TIMEOUT_ENV);

	return DEFAULT_REQUEST_TIMEOUT_MS;
}

function resolveOllamaStartupTimeoutMs(timeoutMs: number): number {
	const envTimeout = process.env[OLLAMA_STARTUP_TIMEOUT_ENV]?.trim();
	if (envTimeout) return parseTimeoutMs(envTimeout, OLLAMA_STARTUP_TIMEOUT_ENV);

	return Math.min(timeoutMs, DEFAULT_OLLAMA_STARTUP_TIMEOUT_MS);
}

function isLoopbackHost(host: string): boolean {
	try {
		const { hostname } = new URL(host);
		return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]";
	} catch {
		return false;
	}
}

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
	return new Promise((resolve, reject) => {
		const cleanup = () => signal?.removeEventListener("abort", abort);
		const timeout = setTimeout(() => {
			cleanup();
			resolve();
		}, ms);
		const abort = () => {
			clearTimeout(timeout);
			cleanup();
			reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
		};

		if (signal?.aborted) abort();
		else signal?.addEventListener("abort", abort, { once: true });
	});
}

function startOllama(host: string): void {
	if (!isLoopbackHost(host) || STARTED_OLLAMA_PROCESSES.has(host)) return;

	const child = spawn("ollama", ["serve"], {
		detached: true,
		stdio: "ignore",
		env: { ...process.env, OLLAMA_HOST: host },
	});

	STARTED_OLLAMA_PROCESSES.add(host);
	child.on("error", () => STARTED_OLLAMA_PROCESSES.delete(host));
	child.unref();
}

async function waitForOllama(host: string, timeoutMs: number, signal: AbortSignal | undefined): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	let lastError: unknown;

	while (Date.now() < deadline) {
		const remainingMs = deadline - Date.now();
		const requestSignal = createRequestSignal(signal, Math.max(1, Math.min(1_000, remainingMs)));

		try {
			const response = await fetch(`${host}/api/tags`, { signal: requestSignal.signal });
			if (response.ok) return;
			lastError = new Error(`HTTP ${response.status}`);
		} catch (error) {
			if (requestSignal.timedOut()) lastError = error;
			else if (isAbortError(error) && signal?.aborted) throw error;
			else lastError = error;
		} finally {
			requestSignal.cleanup();
		}

		await sleep(Math.min(250, Math.max(1, deadline - Date.now())), signal);
	}

	const details = collectErrorText(lastError);
	throw new Error(`Started Ollama for ${host}, but it did not become ready within ${timeoutMs}ms.${details ? ` ${details}` : ""}`);
}

async function ensureOllamaRunning(host: string, timeoutMs: number, signal: AbortSignal | undefined): Promise<void> {
	if (!isLoopbackHost(host)) return;

	startOllama(host);
	await waitForOllama(host, resolveOllamaStartupTimeoutMs(timeoutMs), signal);
}

function createRequestSignal(parentSignal: AbortSignal | undefined, timeoutMs: number) {
	const controller = new AbortController();
	let timedOut = false;

	const timeout = setTimeout(() => {
		timedOut = true;
		controller.abort();
	}, timeoutMs);

	const abortFromParent = () => controller.abort(parentSignal?.reason);
	if (parentSignal?.aborted) abortFromParent();
	else parentSignal?.addEventListener("abort", abortFromParent, { once: true });

	return {
		signal: controller.signal,
		timedOut: () => timedOut,
		cleanup: () => {
			clearTimeout(timeout);
			parentSignal?.removeEventListener("abort", abortFromParent);
		},
	};
}

function collectErrorText(error: unknown): string {
	const parts: string[] = [];
	const seen = new Set<unknown>();

	function visit(value: unknown, depth: number) {
		if (!value || depth > 4 || seen.has(value)) return;
		seen.add(value);

		if (value instanceof Error) {
			parts.push(`${value.name}: ${value.message}`);
		}

		if (typeof value === "object") {
			const record = value as { cause?: unknown; code?: unknown; errno?: unknown };
			if (typeof record.code === "string") parts.push(record.code);
			if (typeof record.errno === "string") parts.push(record.errno);
			visit(record.cause, depth + 1);
		} else if (typeof value === "string") {
			parts.push(value);
		}
	}

	visit(error, 0);
	return parts.join(" ");
}

function errorIncludes(error: unknown, ...needles: string[]): boolean {
	const text = collectErrorText(error).toUpperCase();
	return needles.some((needle) => text.includes(needle.toUpperCase()));
}

function isConnectionRefused(error: unknown): boolean {
	return errorIncludes(error, "ECONNREFUSED");
}

function isAbortError(error: unknown): boolean {
	return error instanceof Error && (error.name === "AbortError" || errorIncludes(error, "ABORT_ERR"));
}

function endpointName(operation: Operation): "web_search" | "web_fetch" {
	return operation === "Search" ? "web_search" : "web_fetch";
}

function operationNoun(operation: Operation): "search" | "fetch" {
	return operation === "Search" ? "search" : "fetch";
}

function formatErrorBody(body: string): string {
	const normalized = body.trim().replace(/\s+/g, " ");
	if (!normalized) return "";
	return normalized.length > MAX_ERROR_BODY_CHARS ? `${normalized.slice(0, MAX_ERROR_BODY_CHARS)}…` : normalized;
}

function createHttpError(response: Response, operation: Operation, host: string, body: string): Error {
	const apiName = endpointName(operation);
	const bodySuffix = formatErrorBody(body);
	const withBody = bodySuffix ? ` Response: ${bodySuffix}` : "";

	if (response.status === 401) {
		return new Error(`Unauthorized by Ollama ${apiName} API at ${host}. Run \`ollama signin\` to authenticate.`);
	}

	if (response.status === 403) {
		return new Error(`Ollama ${apiName} API at ${host} denied the request (HTTP 403). Check \`ollama signin\` and account access.${withBody}`);
	}

	if (response.status === 404 || response.status === 405) {
		return new OllamaEndpointUnavailableError(
			`Ollama ${apiName} endpoint is not available at ${host} (HTTP ${response.status}). ` +
				`Update Ollama and make sure experimental web ${operationNoun(operation)} is enabled.${withBody}`,
			response.status,
		);
	}

	if (response.status >= 500) {
		return new Error(`Ollama ${apiName} API at ${host} failed (HTTP ${response.status}).${withBody || ` ${response.statusText}`}`);
	}

	return new Error(`Ollama ${apiName} API at ${host} returned HTTP ${response.status}.${withBody || ` ${response.statusText}`}`);
}

function isEndpointUnavailable(error: unknown): boolean {
	return error instanceof OllamaEndpointUnavailableError;
}

async function waitForEndpointReady<T>(request: () => Promise<T>, host: string, operation: Operation, timeoutMs: number, signal: AbortSignal | undefined): Promise<T> {
	const startupTimeoutMs = resolveOllamaStartupTimeoutMs(timeoutMs);
	const deadline = Date.now() + startupTimeoutMs;
	let lastError: unknown;

	while (Date.now() < deadline) {
		try {
			return await request();
		} catch (error) {
			if (!isEndpointUnavailable(error)) throw error;
			lastError = error;
		}

		await sleep(Math.min(250, Math.max(1, deadline - Date.now())), signal);
	}

	throw lastError instanceof Error
		? lastError
		: new Error(`Ollama ${endpointName(operation)} endpoint at ${host} did not become ready within ${startupTimeoutMs}ms.`);
}

async function readJsonResponse<T>(response: Response, operation: Operation, host: string): Promise<T> {
	const body = await response.text().catch(() => "");

	if (!response.ok) throw createHttpError(response, operation, host, body);
	if (!body.trim()) throw new Error(`Ollama ${endpointName(operation)} API at ${host} returned an empty response.`);

	try {
		return JSON.parse(body) as T;
	} catch (error) {
		const parseMessage = error instanceof Error ? error.message : String(error);
		const bodySuffix = formatErrorBody(body);
		throw new Error(`Ollama ${endpointName(operation)} API at ${host} returned invalid JSON: ${parseMessage}.${bodySuffix ? ` Body: ${bodySuffix}` : ""}`);
	}
}

function normalizeOllamaError(error: unknown, operation: Operation, host: string, timeoutMs: number, timedOut: boolean, parentSignal: AbortSignal | undefined): Error {
	const apiName = endpointName(operation);

	if (timedOut) {
		return new Error(
			`Ollama ${apiName} request to ${host} timed out after ${timeoutMs}ms. ` +
				`Increase timeout_ms or ${REQUEST_TIMEOUT_ENV} if the web endpoint is slow.`,
		);
	}

	if (isAbortError(error) && parentSignal?.aborted) {
		return new Error(`Ollama ${apiName} request was cancelled.`);
	}

	if (isConnectionRefused(error)) {
		return new Error(`Could not connect to Ollama at ${host}. Make sure Ollama is running, OLLAMA_HOST is correct, and ${apiName} is enabled.`);
	}

	if (errorIncludes(error, "ENOTFOUND", "EAI_AGAIN")) {
		return new Error(`Could not resolve Ollama host ${host}. Check OLLAMA_HOST.`);
	}

	if (errorIncludes(error, "ECONNRESET", "ETIMEDOUT", "UND_ERR_SOCKET", "UND_ERR_CONNECT_TIMEOUT")) {
		const details = collectErrorText(error);
		return new Error(`Connection to Ollama at ${host} failed while calling ${apiName}.${details ? ` ${details}` : ""}`);
	}

	if (error instanceof TypeError && error.message.toLowerCase().includes("fetch")) {
		return new Error(`Request to Ollama at ${host} failed while calling ${apiName}: ${error.message}`);
	}

	return error instanceof Error ? error : new Error(String(error));
}

async function postOllamaJson<T>(host: string, endpoint: "web_search" | "web_fetch", body: Record<string, unknown>, operation: Operation, signal: AbortSignal | undefined, timeoutMs: number, retryEndpointUnavailable = true): Promise<T> {
	const requestSignal = createRequestSignal(signal, timeoutMs);

	try {
		const response = await fetch(`${host}/api/experimental/${endpoint}`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
			signal: requestSignal.signal,
		});

		return await readJsonResponse<T>(response, operation, host);
	} catch (error) {
		if (isConnectionRefused(error) && isLoopbackHost(host)) {
			requestSignal.cleanup();
			await ensureOllamaRunning(host, timeoutMs, signal);
			return waitForEndpointReady(() => postOllamaJson<T>(host, endpoint, body, operation, signal, timeoutMs, false), host, operation, timeoutMs, signal);
		}

		if (retryEndpointUnavailable && isEndpointUnavailable(error) && isLoopbackHost(host)) {
			requestSignal.cleanup();
			return waitForEndpointReady(() => postOllamaJson<T>(host, endpoint, body, operation, signal, timeoutMs, false), host, operation, timeoutMs, signal);
		}

		throw normalizeOllamaError(error, operation, host, timeoutMs, requestSignal.timedOut(), signal);
	} finally {
		requestSignal.cleanup();
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function parseSearchResponse(data: unknown): SearchResponse {
	if (!isRecord(data) || !Array.isArray(data.results)) {
		throw new Error("Ollama web_search API returned an unexpected response: missing results array.");
	}

	return {
		results: data.results.map((item, index) => {
			if (!isRecord(item)) throw new Error(`Ollama web_search API returned an invalid result at index ${index}.`);

			const url = optionalString(item.url);
			if (!url) throw new Error(`Ollama web_search API returned an invalid result at index ${index}: missing url.`);

			return {
				title: optionalString(item.title) || "Untitled",
				url,
				content: optionalString(item.content) || "",
			};
		}),
	};
}

function parseFetchResponse(data: unknown): FetchResponse {
	if (!isRecord(data) || typeof data.content !== "string") {
		throw new Error("Ollama web_fetch API returned an unexpected response: missing content string.");
	}

	return {
		title: optionalString(data.title) || "Untitled",
		content: data.content,
		links: Array.isArray(data.links) ? data.links.filter((link): link is string => typeof link === "string") : undefined,
	};
}

function truncateForTool(text: string): { text: string; truncated: boolean } {
	const truncation = truncateHead(text, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
	if (!truncation.truncated) return { text: truncation.content, truncated: false };

	return {
		text: [
			truncation.content,
			`[Output truncated: ${truncation.outputLines} of ${truncation.totalLines} lines (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}).]`,
		].join("\n\n"),
		truncated: true,
	};
}

function formatSearchResults(results: SearchResult[]): string {
	if (results.length === 0) return "No results found.";

	return results
		.map((result, index) => {
			const snippet = result.content ? `\n   ${result.content}` : "";
			return `${index + 1}. ${result.title}\n   URL: ${result.url}${snippet}`;
		})
		.join("\n\n");
}

function formatFetchResult(data: FetchResponse): string {
	const links = data.links ?? [];
	const visibleLinks = links.slice(0, 10);
	const hiddenLinkCount = Math.max(0, links.length - visibleLinks.length);

	return [
		`Title: ${data.title}`,
		"",
		"Content:",
		data.content,
		"",
		`Links found: ${links.length}`,
		...visibleLinks.map((link) => `  - ${link}`),
		hiddenLinkCount > 0 ? `  … ${hiddenLinkCount} more link(s) omitted` : undefined,
	].filter((line): line is string => line !== undefined).join("\n");
}

function contentByteLength(text: string): number {
	return new TextEncoder().encode(text).byteLength;
}

function timeoutParameterDescription(): string {
	return `Request timeout in milliseconds (default: ${DEFAULT_REQUEST_TIMEOUT_MS}; env override: ${REQUEST_TIMEOUT_ENV}; max: ${MAX_REQUEST_TIMEOUT_MS})`;
}

function timeoutParameter() {
	return Type.Optional(
		Type.Number({
			description: timeoutParameterDescription(),
			default: DEFAULT_REQUEST_TIMEOUT_MS,
			minimum: 1,
			maximum: MAX_REQUEST_TIMEOUT_MS,
		}),
	);
}

function searchResultDetails(data: SearchResponse, host: string, timeoutMs: number, truncated: boolean) {
	return {
		results: data.results,
		resultCount: data.results.length,
		host,
		timeoutMs,
		truncated,
	};
}

function fetchResultDetails(data: FetchResponse, host: string, timeoutMs: number, truncated: boolean) {
	return {
		title: data.title,
		content: data.content,
		contentBytes: contentByteLength(data.content),
		links: data.links ?? [],
		linkCount: data.links?.length ?? 0,
		host,
		timeoutMs,
		truncated,
	};
}

export default function webSearch(pi: ExtensionAPI) {
	pi.registerTool({
		...WEB_SEARCH_TOOL_DESCRIPTIONS.webSearch,
		parameters: Type.Object({
			query: Type.String({ description: "The search query to execute" }),
			max_results: Type.Optional(Type.Number({ description: "Maximum number of search results to return (default: 5)", default: 5 })),
			timeout_ms: timeoutParameter(),
		}),
		async execute(_toolCallId, params, signal) {
			const maxResults = params.max_results ?? 5;
			const host = getOllamaHost();
			const timeoutMs = resolveRequestTimeoutMs(params.timeout_ms);

			const rawData = await postOllamaJson<unknown>(host, "web_search", { query: params.query, max_results: maxResults }, "Search", signal, timeoutMs);
			const data = parseSearchResponse(rawData);
			const formatted = truncateForTool(formatSearchResults(data.results));

			return {
				content: [{ type: "text", text: formatted.text }],
				details: searchResultDetails(data, host, timeoutMs, formatted.truncated),
			};
		},
	});

	pi.registerTool({
		...WEB_SEARCH_TOOL_DESCRIPTIONS.webFetch,
		parameters: Type.Object({
			url: Type.String({ description: "URL to fetch and extract content from" }),
			timeout_ms: timeoutParameter(),
		}),
		async execute(_toolCallId, params, signal) {
			const host = getOllamaHost();
			const timeoutMs = resolveRequestTimeoutMs(params.timeout_ms);

			const rawData = await postOllamaJson<unknown>(host, "web_fetch", { url: params.url }, "Fetch", signal, timeoutMs);
			const data = parseFetchResponse(rawData);
			const formatted = truncateForTool(formatFetchResult(data));

			return {
				content: [{ type: "text", text: formatted.text }],
				details: fetchResultDetails(data, host, timeoutMs, formatted.truncated),
			};
		},
	});
}
