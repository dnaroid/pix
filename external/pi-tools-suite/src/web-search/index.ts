import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, truncateHead } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { WEB_SEARCH_TOOL_DESCRIPTIONS } from "../tool-descriptions";
import { suiteDiagnostics } from "../lib/suite-diagnostics.js";
import { BRAVE_SEARCH_HEADERS, BRAVE_SEARCH_HOST, braveSearchUrl, parseBraveSearchHtml } from "./brave-search.js";
import { downloadPublicPage, parsePublicPageUrl } from "./public-page.js";

interface SearchResult {
	title: string;
	url: string;
	content: string;
}

interface SearchResponse {
	results: SearchResult[];
}

type Provider = "tavily" | "brave";

interface ProviderFailure {
	provider: Provider;
	error: string;
}

interface ProviderResponse {
	data: SearchResponse;
	provider: Provider;
	host: string;
	/** Primary provider failure when a fallback answered. */
	fallbackFrom?: ProviderFailure;
	/** Every provider error encountered, in order. */
	failures?: ProviderFailure[];
	emptyProviders: Provider[];
}

interface SearchAttempt {
	provider: Provider;
	label: string;
	host: string;
	request: () => Promise<SearchResponse>;
}

const TAVILY_ENDPOINT = "search";
const TAVILY_API_HOST = "https://api.tavily.com";
const TAVILY_API_KEY_ENV = "TAVILY_API_KEY";
const TAVILY_API_KEYS_URL = "https://app.tavily.com/home";
const CREDENTIAL_PATH_ENV = "PI_TOOLS_SUITE_WEB_CREDENTIALS_PATH";
const TAVILY_MAX_SEARCH_RESULTS = 20;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const MAX_REQUEST_TIMEOUT_MS = 120_000;
const REQUEST_TIMEOUT_ENV = "PI_WEB_SEARCH_TIMEOUT_MS";
const MAX_ERROR_BODY_CHARS = 1_200;
function credentialPath(): string {
	return process.env[CREDENTIAL_PATH_ENV]?.trim() || join(homedir(), ".config", "pi", "pi-tools-suite-credentials.json");
}

function readStoredCredentials(): Record<string, unknown> {
	try {
		const value = JSON.parse(readFileSync(credentialPath(), "utf8")) as unknown;
		return isRecord(value) ? value : {};
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
		throw error;
	}
}

function writeStoredCredentials(credentials: Record<string, unknown>): void {
	const path = credentialPath();
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	const tempPath = `${path}.${process.pid}.${Date.now()}.tmp`;

	try {
		writeFileSync(tempPath, `${JSON.stringify(credentials, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
		renameSync(tempPath, path);
		chmodSync(path, 0o600);
	} finally {
		if (existsSync(tempPath)) unlinkSync(tempPath);
	}
}

function updateStoredCredential(apiKey: string | undefined): void {
	const credentials = readStoredCredentials();
	if (apiKey) credentials.tavily = apiKey;
	else delete credentials.tavily;
	writeStoredCredentials(credentials);
}

function storedTavilyKey(): string | undefined {
	return optionalString(readStoredCredentials().tavily)?.trim() || undefined;
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

function isAbortError(error: unknown): boolean {
	return error instanceof Error && (error.name === "AbortError" || errorIncludes(error, "ABORT_ERR"));
}

function formatErrorBody(body: string): string {
	const normalized = body.trim().replace(/\s+/g, " ");
	if (!normalized) return "";
	return normalized.length > MAX_ERROR_BODY_CHARS ? `${normalized.slice(0, MAX_ERROR_BODY_CHARS)}…` : normalized;
}

function createTavilyHttpError(response: Response, body: string): Error {
	const endpoint = TAVILY_ENDPOINT;
	const bodySuffix = formatErrorBody(body);
	const withBody = bodySuffix ? ` Response: ${bodySuffix}` : "";

	if (response.status === 401) {
		return new Error(`Tavily ${endpoint} API rejected ${TAVILY_API_KEY_ENV} (HTTP 401). Check that the API key is valid.`);
	}

	if (response.status === 429 || response.status === 432 || response.status === 433) {
		return new Error(`Tavily ${endpoint} API limit was exceeded (HTTP ${response.status}).${withBody}`);
	}

	return new Error(`Tavily ${endpoint} API returned HTTP ${response.status}.${withBody || ` ${response.statusText}`}`);
}

function normalizeTavilyError(error: unknown, timeoutMs: number, timedOut: boolean, parentSignal: AbortSignal | undefined): Error {
	const endpoint = TAVILY_ENDPOINT;

	if (timedOut) {
		return new Error(
			`Tavily ${endpoint} request timed out after ${timeoutMs}ms. ` +
				`Increase timeout_ms or ${REQUEST_TIMEOUT_ENV} if the fallback endpoint is slow.`,
		);
	}

	if (isAbortError(error) && parentSignal?.aborted) {
		return new Error(`Tavily ${endpoint} request was cancelled.`);
	}

	if (errorIncludes(error, "ENOTFOUND", "EAI_AGAIN")) {
		return new Error(`Could not resolve Tavily host ${TAVILY_API_HOST}.`);
	}

	if (errorIncludes(error, "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "UND_ERR_SOCKET", "UND_ERR_CONNECT_TIMEOUT")) {
		const details = collectErrorText(error);
		return new Error(`Connection to Tavily failed while calling ${endpoint}.${details ? ` ${details}` : ""}`);
	}

	if (error instanceof TypeError && error.message.toLowerCase().includes("fetch")) {
		return new Error(`Request to Tavily failed while calling ${endpoint}: ${error.message}`);
	}

	return error instanceof Error ? error : new Error(String(error));
}

async function postTavilyJson<T>(apiKey: string, body: Record<string, unknown>, signal: AbortSignal | undefined, timeoutMs: number): Promise<T> {
	const endpoint = TAVILY_ENDPOINT;
	const requestSignal = createRequestSignal(signal, timeoutMs);

	try {
		const response = await fetch(`${TAVILY_API_HOST}/${endpoint}`, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${apiKey}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify(body),
			signal: requestSignal.signal,
		});
		const responseBody = await response.text().catch(() => "");

		if (!response.ok) throw createTavilyHttpError(response, responseBody);
		if (!responseBody.trim()) throw new Error(`Tavily ${endpoint} API returned an empty response.`);

		try {
			return JSON.parse(responseBody) as T;
		} catch (error) {
			const parseMessage = error instanceof Error ? error.message : String(error);
			const bodySuffix = formatErrorBody(responseBody);
			throw new Error(`Tavily ${endpoint} API returned invalid JSON: ${parseMessage}.${bodySuffix ? ` Body: ${bodySuffix}` : ""}`);
		}
	} catch (error) {
		throw normalizeTavilyError(error, timeoutMs, requestSignal.timedOut(), signal);
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

function parseSearchResponse(data: unknown, providerName: string): SearchResponse {
	if (!isRecord(data) || !Array.isArray(data.results)) {
		throw new Error(`${providerName} web_search API returned an unexpected response: missing results array.`);
	}

	return {
		results: data.results.map((item, index) => {
			if (!isRecord(item)) throw new Error(`${providerName} web_search API returned an invalid result at index ${index}.`);

			const url = optionalString(item.url);
			if (!url) throw new Error(`${providerName} web_search API returned an invalid result at index ${index}: missing url.`);

			return {
				title: optionalString(item.title) || "Untitled",
				url,
				content: optionalString(item.content) || "",
			};
		}),
	};
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Stops on the first non-empty response; an empty response is better than no response. */
async function runSearchChain(signal: AbortSignal | undefined, attempts: SearchAttempt[]): Promise<ProviderResponse> {
	const failures: Array<ProviderFailure & { label: string }> = [];
	const emptyProviders: Provider[] = [];
	let response: ProviderResponse | undefined;

	for (const attempt of attempts) {
		signal?.throwIfAborted();
		try {
			const data = await attempt.request();
			signal?.throwIfAborted();
			const firstFailure = failures[0];
			response = {
				data,
				provider: attempt.provider,
				host: attempt.host,
				fallbackFrom: firstFailure && { provider: firstFailure.provider, error: firstFailure.error },
				emptyProviders,
			};
			if (data.results.length > 0) break;
			emptyProviders.push(attempt.provider);
		} catch (error) {
			if (signal?.aborted) throw error;
			failures.push({ provider: attempt.provider, label: attempt.label, error: errorMessage(error) });
		}
	}

	if (response) {
		if (failures.length) response.failures = failures.map(({ provider, error }) => ({ provider, error }));
		return response;
	}

	if (failures.length === 1) throw new Error(failures[0].error);
	throw new Error(
		failures
			.map((failure, index) => `${failure.label} ${index === 0 ? "failed" : "fallback also failed"}: ${failure.error}`)
			.join(" "),
	);
}

function normalizeBraveError(error: unknown, timeoutMs: number, timedOut: boolean, parentSignal: AbortSignal | undefined): Error {
	if (timedOut) return new Error(`Brave Search request timed out after ${timeoutMs}ms.`);
	if (isAbortError(error) && parentSignal?.aborted) return new Error("Brave Search request was cancelled.");
	if (errorIncludes(error, "ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "UND_ERR_SOCKET", "UND_ERR_CONNECT_TIMEOUT")) {
		const details = collectErrorText(error);
		return new Error(`Connection to Brave Search failed.${details ? ` ${details}` : ""}`);
	}
	return error instanceof Error ? error : new Error(String(error));
}

const BRAVE_MAX_BYTES = 4 * 1024 * 1024;
const STATUS_MARKER = "\n__PI_HTTP_STATUS__:";

export type BraveTransport = (url: string, signal: AbortSignal) => Promise<{ status: number; body: string }>;

/**
 * Brave rejects Node/Bun TLS clients (HTTP 429) but serves curl, so the keyless search
 * shells out to the system curl without a shell; arguments are passed as an argv array.
 */
const curlTransport: BraveTransport = (url, signal) => new Promise((resolve, reject) => {
	const args = ["-sS", "--compressed", "--max-filesize", String(BRAVE_MAX_BYTES), "-w", `${STATUS_MARKER}%{http_code}`];
	for (const [name, value] of Object.entries(BRAVE_SEARCH_HEADERS)) args.push("-H", `${name}: ${value}`);
	args.push("--", url);
	const child = spawn("curl", args, { stdio: ["ignore", "pipe", "pipe"], signal });
	const out: Buffer[] = [];
	const err: Buffer[] = [];
	let bytes = 0;
	child.stdout?.on("data", (chunk: Buffer) => {
		bytes += chunk.byteLength;
		if (bytes > BRAVE_MAX_BYTES + 64) child.kill();
		else out.push(chunk);
	});
	child.stderr?.on("data", (chunk: Buffer) => err.push(chunk));
	child.once("error", (error) => reject(errorIncludes(error, "ENOENT") ? new Error("curl is not installed; Brave Search is unavailable.") : error));
	child.once("close", (code) => {
		const text = Buffer.concat(out).toString("utf8");
		const marker = text.lastIndexOf(STATUS_MARKER);
		if (code !== 0 || marker < 0) {
			reject(new Error(`curl failed (exit ${code}). ${formatErrorBody(Buffer.concat(err).toString("utf8"))}`.trim()));
			return;
		}
		resolve({ status: Number(text.slice(marker + STATUS_MARKER.length).trim()), body: text.slice(0, marker) });
	});
});

let braveTransport: BraveTransport = curlTransport;

export function __setBraveTransportForTests(next: BraveTransport | undefined): void {
	braveTransport = next ?? curlTransport;
}

/** Keyless fallback: fetches the public Brave Search results page and parses it locally. */
async function searchBrave(query: string, maxResults: number, signal: AbortSignal | undefined, timeoutMs: number): Promise<SearchResponse> {
	const requestSignal = createRequestSignal(signal, timeoutMs);

	try {
		const response = await braveTransport(braveSearchUrl(query), requestSignal.signal);
		const body = response.body;
		if (response.status === 429) throw new Error("Brave Search rate limit was exceeded (HTTP 429).");
		if (response.status < 200 || response.status >= 300) throw new Error(`Brave Search returned HTTP ${response.status}.`);
		const limit = Math.max(0, Math.trunc(maxResults));
		return { results: parseBraveSearchHtml(body).slice(0, limit) };
	} catch (error) {
		throw normalizeBraveError(error, timeoutMs, requestSignal.timedOut(), signal);
	} finally {
		requestSignal.cleanup();
	}
}

type CredentialChoice =
	| "Set Tavily API key"
	| "Show credential status"
	| "Clear stored Tavily key";

const CREDENTIAL_CHOICES: CredentialChoice[] = [
	"Set Tavily API key",
	"Show credential status",
	"Clear stored Tavily key",
];

function showCredentialStatus(ctx: ExtensionCommandContext): void {
	const tavily = process.env[TAVILY_API_KEY_ENV]?.trim()
		? `environment (${TAVILY_API_KEY_ENV})`
		: storedTavilyKey() ? "stored in pi-tools-suite credentials" : "not configured";
	ctx.ui.notify(`Web credentials\nTavily: ${tavily}`, "info");
}

function showCredentialLinks(ctx: ExtensionCommandContext): void {
	ctx.ui.notify(
		`Get a Tavily API key: ${TAVILY_API_KEYS_URL}`,
		"info",
	);
}

async function setCredential(ctx: ExtensionCommandContext): Promise<void> {
	const key = (await ctx.ui.input("Tavily API key", "Paste the API key; Escape cancels"))?.trim();
	if (!key) {
		ctx.ui.notify("Tavily credential was not changed.", "warning");
		return;
	}

	updateStoredCredential(key);
	ctx.ui.notify("Tavily credential saved securely and active for future web tool calls.", "info");
}

function clearCredential(ctx: ExtensionCommandContext): void {
	updateStoredCredential(undefined);
	const envSuffix = process.env[TAVILY_API_KEY_ENV]?.trim() ? ` ${TAVILY_API_KEY_ENV} is still set and remains active.` : "";
	ctx.ui.notify(`Stored Tavily credential removed.${envSuffix}`, "info");
}

function registerCredentialCommand(pi: ExtensionAPI): void {
	pi.registerCommand("web-credentials", {
		description: "Configure the Tavily API key for web_search",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) return;
			showCredentialLinks(ctx);

			const choice = await ctx.ui.select("Web search credentials", CREDENTIAL_CHOICES) as CredentialChoice | undefined;
			switch (choice) {
				case "Set Tavily API key":
					await setCredential(ctx);
					break;
				case "Show credential status":
					showCredentialStatus(ctx);
					break;
				case "Clear stored Tavily key":
					clearCredential(ctx);
					break;
			}
		},
	});
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

function searchResultDetails(response: ProviderResponse, timeoutMs: number, truncated: boolean) {
	return {
		results: response.data.results,
		resultCount: response.data.results.length,
		provider: response.provider,
		host: response.host,
		fallbackFrom: response.fallbackFrom,
		failures: response.failures,
		emptyProviders: response.emptyProviders,
		timeoutMs,
		truncated,
	};
}

export default function webSearch(pi: ExtensionAPI) {
	registerCredentialCommand(pi);

	pi.registerTool({
		...WEB_SEARCH_TOOL_DESCRIPTIONS.webSearch,
		parameters: Type.Object({
			query: Type.String({ description: "The search query to execute" }),
			max_results: Type.Optional(Type.Number({ description: "Maximum number of search results to return (default: 5)", default: 5 })),
			timeout_ms: timeoutParameter(),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const maxResults = params.max_results ?? 5;
			const tavilyApiKey = process.env[TAVILY_API_KEY_ENV]?.trim() || storedTavilyKey();
			const timeoutMs = resolveRequestTimeoutMs(params.timeout_ms);

			const attempts: SearchAttempt[] = [{
				provider: "brave",
				label: "Brave Search",
				host: BRAVE_SEARCH_HOST,
				request: () => searchBrave(params.query, maxResults, signal, timeoutMs),
			}];
			if (tavilyApiKey) {
				attempts.push({
					provider: "tavily",
					label: `Tavily ${TAVILY_ENDPOINT}`,
					host: TAVILY_API_HOST,
					request: async () => parseSearchResponse(
						await postTavilyJson<unknown>(tavilyApiKey, {
							query: params.query,
							max_results: Math.max(0, Math.min(TAVILY_MAX_SEARCH_RESULTS, Math.trunc(maxResults))),
							search_depth: "basic",
						}, signal, timeoutMs),
						"Tavily",
					),
				});
			}

			const response = await runSearchChain(signal, attempts);
			if (response.failures?.length) suiteDiagnostics.report("warn", "web", "search-provider-fallback", ctx?.cwd);
			const formatted = truncateForTool(`Provider: ${response.provider}\n\n${formatSearchResults(response.data.results)}`);

			return {
				content: [{ type: "text", text: formatted.text }],
				details: searchResultDetails(response, timeoutMs, formatted.truncated),
			};
		},
	});

	pi.registerTool({
		...WEB_SEARCH_TOOL_DESCRIPTIONS.webFetch,
		parameters: Type.Object({
			url: Type.String({ description: "URL to fetch and extract content from" }),
			timeout_ms: timeoutParameter(),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const timeoutMs = resolveRequestTimeoutMs(params.timeout_ms);
			const deadline = performance.now() + timeoutMs;
			const request = createRequestSignal(signal, timeoutMs);
			try {
				request.signal.throwIfAborted();
				const url = parsePublicPageUrl(params.url);
				const source = await downloadPublicPage(url, request.signal);
				const reader = source.html ? await import("./page-markdown.js") : undefined;
				request.signal.throwIfAborted();
				const page = reader?.extractPageMarkdown(source.text, source.url) ?? { title: "", content: source.text };
				request.signal.throwIfAborted();
				if (!page.content.trim()) throw new Error("No readable content found.");
				const title = page.title || "Untitled";
				const formatted = truncateForTool(`Title: ${title}\nURL: ${source.url.href}\n\nContent:\n${page.content}`);
				if (performance.now() >= deadline) throw new Error("Page processing exceeded its deadline.");
				return {
					content: [{ type: "text", text: formatted.text }],
					details: {
						title,
						content: page.content,
						contentBytes: Buffer.byteLength(page.content),
						provider: "local",
						host: url.origin,
						timeoutMs,
						truncated: formatted.truncated,
					},
				};
			} catch (error) {
				if (signal?.aborted) throw new Error("web_fetch request was cancelled.");
				const timedOut = request.timedOut() || performance.now() >= deadline;
				suiteDiagnostics.report("warn", "web", timedOut ? "fetch-timeout" : "fetch-failed", ctx?.cwd);
				if (timedOut) throw new Error(`web_fetch request timed out after ${timeoutMs}ms.`);
				throw new Error(`web_fetch failed: ${errorMessage(error)}`);
			} finally {
				request.cleanup();
			}
		},
	});
}
