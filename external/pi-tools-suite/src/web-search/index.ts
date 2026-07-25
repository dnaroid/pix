import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, truncateHead } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { WEB_SEARCH_TOOL_DESCRIPTIONS } from "../tool-descriptions";

let spawnImpl: typeof spawn = spawn;

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
type Provider = "ollama" | "tavily";

interface ProviderResponse<T> {
	data: T;
	provider: Provider;
	host: string;
	fallbackFrom?: {
		provider: "ollama";
		error: string;
	};
}

interface OllamaTarget {
	host: string;
	apiKey?: string;
}

class OllamaEndpointUnavailableError extends Error {
	constructor(message: string, readonly status: number) {
		super(message);
		this.name = "OllamaEndpointUnavailableError";
	}
}

const DEFAULT_OLLAMA_HOST = "http://localhost:11434";
const OLLAMA_CLOUD_HOST = "https://ollama.com";
const OLLAMA_API_KEY_ENV = "OLLAMA_API_KEY";
const OLLAMA_API_KEYS_URL = "https://ollama.com/settings/keys";
const TAVILY_API_HOST = "https://api.tavily.com";
const TAVILY_API_KEY_ENV = "TAVILY_API_KEY";
const TAVILY_API_KEYS_URL = "https://app.tavily.com/home";
const CREDENTIAL_PATH_ENV = "PI_TOOLS_SUITE_WEB_CREDENTIALS_PATH";
const TAVILY_MAX_SEARCH_RESULTS = 20;
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

interface StoredCredentials {
	ollama?: string;
	tavily?: string;
}

type StoredCredentialName = keyof StoredCredentials;

function credentialPath(): string {
	return process.env[CREDENTIAL_PATH_ENV]?.trim() || join(homedir(), ".config", "pi", "pi-tools-suite-credentials.json");
}

function readStoredCredentials(): StoredCredentials {
	try {
		const value = JSON.parse(readFileSync(credentialPath(), "utf8")) as unknown;
		if (!isRecord(value)) return {};
		return {
			ollama: optionalString(value.ollama)?.trim() || undefined,
			tavily: optionalString(value.tavily)?.trim() || undefined,
		};
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
		throw error;
	}
}

function writeStoredCredentials(credentials: StoredCredentials): void {
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

function updateStoredCredential(name: StoredCredentialName, apiKey: string | undefined): void {
	const credentials = readStoredCredentials();
	if (apiKey) credentials[name] = apiKey;
	else delete credentials[name];
	writeStoredCredentials(credentials);
}

function resolveApiKey(envName: string, credentialName: StoredCredentialName): string | undefined {
	const envKey = process.env[envName]?.trim();
	if (envKey) return envKey;
	return readStoredCredentials()[credentialName];
}

function resolveOllamaTarget(): OllamaTarget {
	const apiKey = resolveApiKey(OLLAMA_API_KEY_ENV, "ollama");
	const configuredHost = process.env.OLLAMA_HOST?.trim();

	return {
		host: normalizeOllamaHost(configuredHost || (apiKey ? OLLAMA_CLOUD_HOST : undefined)),
		apiKey,
	};
}

function ollamaRequestUrl(target: OllamaTarget, endpoint: "web_search" | "web_fetch"): string {
	const apiPath = target.host === OLLAMA_CLOUD_HOST ? `/api/${endpoint}` : `/api/experimental/${endpoint}`;
	return `${target.host}${apiPath}`;
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

	const child = spawnImpl("ollama", ["serve"], {
		detached: true,
		stdio: "ignore",
		env: { ...process.env, OLLAMA_HOST: host },
	});

	STARTED_OLLAMA_PROCESSES.add(host);
	child.on("error", () => STARTED_OLLAMA_PROCESSES.delete(host));
	child.unref();
}

export function __setSpawnForTests(nextSpawn: typeof spawn | undefined): void {
	spawnImpl = nextSpawn ?? spawn;
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

function tavilyEndpoint(operation: Operation): "search" | "extract" {
	return operation === "Search" ? "search" : "extract";
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
		return new Error(
			`Unauthorized by Ollama ${apiName} API at ${host}. ` +
			`Run \`ollama signin\` for local Ollama, or update ${OLLAMA_API_KEY_ENV} through /web-credentials or the launch environment.`,
		);
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

async function postOllamaJson<T>(target: OllamaTarget, endpoint: "web_search" | "web_fetch", body: Record<string, unknown>, operation: Operation, signal: AbortSignal | undefined, timeoutMs: number, retryEndpointUnavailable = true): Promise<T> {
	const { host } = target;
	const requestSignal = createRequestSignal(signal, timeoutMs);

	try {
		const response = await fetch(ollamaRequestUrl(target, endpoint), {
			method: "POST",
			headers: {
				...(target.apiKey ? { Authorization: `Bearer ${target.apiKey}` } : {}),
				"Content-Type": "application/json",
			},
			body: JSON.stringify(body),
			signal: requestSignal.signal,
		});

		return await readJsonResponse<T>(response, operation, host);
	} catch (error) {
		if (isConnectionRefused(error) && isLoopbackHost(host)) {
			requestSignal.cleanup();
			await ensureOllamaRunning(host, timeoutMs, signal);
			return waitForEndpointReady(() => postOllamaJson<T>(target, endpoint, body, operation, signal, timeoutMs, false), host, operation, timeoutMs, signal);
		}

		if (retryEndpointUnavailable && isEndpointUnavailable(error) && isLoopbackHost(host)) {
			requestSignal.cleanup();
			return waitForEndpointReady(() => postOllamaJson<T>(target, endpoint, body, operation, signal, timeoutMs, false), host, operation, timeoutMs, signal);
		}

		throw normalizeOllamaError(error, operation, host, timeoutMs, requestSignal.timedOut(), signal);
	} finally {
		requestSignal.cleanup();
	}
}

function createTavilyHttpError(response: Response, operation: Operation, body: string): Error {
	const endpoint = tavilyEndpoint(operation);
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

function normalizeTavilyError(error: unknown, operation: Operation, timeoutMs: number, timedOut: boolean, parentSignal: AbortSignal | undefined): Error {
	const endpoint = tavilyEndpoint(operation);

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

async function postTavilyJson<T>(apiKey: string, operation: Operation, body: Record<string, unknown>, signal: AbortSignal | undefined, timeoutMs: number): Promise<T> {
	const endpoint = tavilyEndpoint(operation);
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

		if (!response.ok) throw createTavilyHttpError(response, operation, responseBody);
		if (!responseBody.trim()) throw new Error(`Tavily ${endpoint} API returned an empty response.`);

		try {
			return JSON.parse(responseBody) as T;
		} catch (error) {
			const parseMessage = error instanceof Error ? error.message : String(error);
			const bodySuffix = formatErrorBody(responseBody);
			throw new Error(`Tavily ${endpoint} API returned invalid JSON: ${parseMessage}.${bodySuffix ? ` Body: ${bodySuffix}` : ""}`);
		}
	} catch (error) {
		throw normalizeTavilyError(error, operation, timeoutMs, requestSignal.timedOut(), signal);
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

function parseSearchResponse(data: unknown, providerName = "Ollama"): SearchResponse {
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

function parseTavilyExtractResponse(data: unknown, requestedUrl: string): FetchResponse {
	if (!isRecord(data) || !Array.isArray(data.results)) {
		throw new Error("Tavily extract API returned an unexpected response: missing results array.");
	}

	const result = data.results.find((item) => isRecord(item) && item.url === requestedUrl) ?? data.results[0];
	if (!isRecord(result) || typeof result.raw_content !== "string") {
		const failedResult = Array.isArray(data.failed_results)
			? data.failed_results.find((item) => isRecord(item) && item.url === requestedUrl) ?? data.failed_results[0]
			: undefined;
		const failedMessage = isRecord(failedResult) ? optionalString(failedResult.error) : undefined;
		throw new Error(`Tavily extract API did not return content for ${requestedUrl}.${failedMessage ? ` ${failedMessage}` : ""}`);
	}

	return {
		title: requestedUrl,
		content: result.raw_content,
		links: [],
	};
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

async function withTavilyFallback<T>(
	operation: Operation,
	signal: AbortSignal | undefined,
	ollamaHost: string,
	tavilyApiKey: string | undefined,
	ollamaRequest: () => Promise<T>,
	tavilyRequest: (apiKey: string) => Promise<T>,
): Promise<ProviderResponse<T>> {
	try {
		return { data: await ollamaRequest(), provider: "ollama", host: ollamaHost };
	} catch (ollamaError) {
		if (signal?.aborted) throw ollamaError;

		if (!tavilyApiKey) throw ollamaError;

		try {
			return {
				data: await tavilyRequest(tavilyApiKey),
				provider: "tavily",
				host: TAVILY_API_HOST,
				fallbackFrom: { provider: "ollama", error: errorMessage(ollamaError) },
			};
		} catch (tavilyError) {
			if (signal?.aborted) throw tavilyError;

			throw new Error(
				`Ollama ${endpointName(operation)} failed: ${errorMessage(ollamaError)} ` +
					`Tavily ${tavilyEndpoint(operation)} fallback also failed: ${errorMessage(tavilyError)}`,
			);
		}
	}
}

type CredentialChoice =
	| "Set Ollama API key"
	| "Set Tavily API key"
	| "Show credential status"
	| "Clear stored Ollama key"
	| "Clear stored Tavily key";

const CREDENTIAL_CHOICES: CredentialChoice[] = [
	"Set Ollama API key",
	"Set Tavily API key",
	"Show credential status",
	"Clear stored Ollama key",
	"Clear stored Tavily key",
];

function storedCredentialConfigured(name: StoredCredentialName): boolean {
	return Boolean(readStoredCredentials()[name]);
}

function credentialSource(envName: string, credentialName: StoredCredentialName): string {
	if (process.env[envName]?.trim()) return `environment (${envName})`;
	return storedCredentialConfigured(credentialName) ? "stored in pi-tools-suite credentials" : "not configured";
}

function showCredentialStatus(ctx: ExtensionCommandContext): void {
	const ollama = credentialSource(OLLAMA_API_KEY_ENV, "ollama");
	const tavily = credentialSource(TAVILY_API_KEY_ENV, "tavily");
	ctx.ui.notify(`Web credentials\nOllama: ${ollama}\nTavily: ${tavily}`, "info");
}

function showCredentialLinks(ctx: ExtensionCommandContext): void {
	ctx.ui.notify(
		`Get API keys\nOllama: ${OLLAMA_API_KEYS_URL}\nTavily: ${TAVILY_API_KEYS_URL}`,
		"info",
	);
}

async function setCredential(
	ctx: ExtensionCommandContext,
	provider: "Ollama" | "Tavily",
	credentialName: StoredCredentialName,
): Promise<void> {
	const key = (await ctx.ui.input(`${provider} API key`, "Paste the API key; Escape cancels"))?.trim();
	if (!key) {
		ctx.ui.notify(`${provider} credential was not changed.`, "warning");
		return;
	}

	updateStoredCredential(credentialName, key);
	ctx.ui.notify(`${provider} credential saved securely and active for future web tool calls.`, "info");
}

function clearCredential(
	ctx: ExtensionCommandContext,
	provider: "Ollama" | "Tavily",
	credentialName: StoredCredentialName,
	envName: string,
): void {
	updateStoredCredential(credentialName, undefined);
	const envSuffix = process.env[envName]?.trim() ? ` ${envName} is still set and remains active.` : "";
	ctx.ui.notify(`Stored ${provider} credential removed.${envSuffix}`, "info");
}

function registerCredentialCommand(pi: ExtensionAPI): void {
	pi.registerCommand("web-credentials", {
		description: "Configure Ollama and Tavily API keys for web_search/web_fetch",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) return;
			showCredentialLinks(ctx);

			const choice = await ctx.ui.select("Web search credentials", CREDENTIAL_CHOICES) as CredentialChoice | undefined;
			switch (choice) {
				case "Set Ollama API key":
					await setCredential(ctx, "Ollama", "ollama");
					break;
				case "Set Tavily API key":
					await setCredential(ctx, "Tavily", "tavily");
					break;
				case "Show credential status":
					showCredentialStatus(ctx);
					break;
				case "Clear stored Ollama key":
					clearCredential(ctx, "Ollama", "ollama", OLLAMA_API_KEY_ENV);
					break;
				case "Clear stored Tavily key":
					clearCredential(ctx, "Tavily", "tavily", TAVILY_API_KEY_ENV);
					break;
			}
		},
	});
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

function searchResultDetails(response: ProviderResponse<SearchResponse>, timeoutMs: number, truncated: boolean) {
	return {
		results: response.data.results,
		resultCount: response.data.results.length,
		provider: response.provider,
		host: response.host,
		fallbackFrom: response.fallbackFrom,
		timeoutMs,
		truncated,
	};
}

function fetchResultDetails(response: ProviderResponse<FetchResponse>, timeoutMs: number, truncated: boolean) {
	const data = response.data;
	return {
		title: data.title,
		content: data.content,
		contentBytes: contentByteLength(data.content),
		links: data.links ?? [],
		linkCount: data.links?.length ?? 0,
		provider: response.provider,
		host: response.host,
		fallbackFrom: response.fallbackFrom,
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
		async execute(_toolCallId, params, signal) {
			const maxResults = params.max_results ?? 5;
			const ollamaTarget = resolveOllamaTarget();
			const tavilyApiKey = resolveApiKey(TAVILY_API_KEY_ENV, "tavily");
			const timeoutMs = resolveRequestTimeoutMs(params.timeout_ms);

			const response = await withTavilyFallback(
				"Search",
				signal,
				ollamaTarget.host,
				tavilyApiKey,
				async () => parseSearchResponse(await postOllamaJson<unknown>(ollamaTarget, "web_search", { query: params.query, max_results: maxResults }, "Search", signal, timeoutMs)),
				async (apiKey) => parseSearchResponse(
					await postTavilyJson<unknown>(apiKey, "Search", {
						query: params.query,
						max_results: Math.max(0, Math.min(TAVILY_MAX_SEARCH_RESULTS, Math.trunc(maxResults))),
						search_depth: "basic",
					}, signal, timeoutMs),
					"Tavily",
				),
			);
			const formatted = truncateForTool(formatSearchResults(response.data.results));

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
		async execute(_toolCallId, params, signal) {
			const ollamaTarget = resolveOllamaTarget();
			const tavilyApiKey = resolveApiKey(TAVILY_API_KEY_ENV, "tavily");
			const timeoutMs = resolveRequestTimeoutMs(params.timeout_ms);

			const response = await withTavilyFallback(
				"Fetch",
				signal,
				ollamaTarget.host,
				tavilyApiKey,
				async () => parseFetchResponse(await postOllamaJson<unknown>(ollamaTarget, "web_fetch", { url: params.url }, "Fetch", signal, timeoutMs)),
				async (apiKey) => parseTavilyExtractResponse(
					await postTavilyJson<unknown>(apiKey, "Fetch", {
						urls: [params.url],
						extract_depth: "basic",
						format: "markdown",
					}, signal, timeoutMs),
					params.url,
				),
			);
			const formatted = truncateForTool(formatFetchResult(response.data));

			return {
				content: [{ type: "text", text: formatted.text }],
				details: fetchResultDetails(response, timeoutMs, formatted.truncated),
			};
		},
	});
}
