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

let spawnImpl: typeof spawn = spawn;

interface SearchResult {
	title: string;
	url: string;
	content: string;
}

interface SearchResponse {
	results: SearchResult[];
}

type Provider = "ollama" | "tavily" | "brave";

interface ProviderFailure {
	provider: Provider;
	error: string;
}

interface ProviderResponse<T> {
	data: T;
	provider: Provider;
	host: string;
	/** Primary provider failure when a fallback answered. */
	fallbackFrom?: ProviderFailure;
	/** Every provider failure before the successful one, in order. */
	failures?: ProviderFailure[];
}

interface SearchAttempt<T> {
	provider: Provider;
	label: string;
	host: string;
	request: () => Promise<T>;
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
const OLLAMA_ENDPOINT = "web_search";
const TAVILY_ENDPOINT = "search";
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

function ollamaRequestUrl(target: OllamaTarget): string {
	const apiPath = target.host === OLLAMA_CLOUD_HOST ? `/api/${OLLAMA_ENDPOINT}` : `/api/experimental/${OLLAMA_ENDPOINT}`;
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

function formatErrorBody(body: string): string {
	const normalized = body.trim().replace(/\s+/g, " ");
	if (!normalized) return "";
	return normalized.length > MAX_ERROR_BODY_CHARS ? `${normalized.slice(0, MAX_ERROR_BODY_CHARS)}…` : normalized;
}

function createHttpError(response: Response, host: string, body: string): Error {
	const apiName = OLLAMA_ENDPOINT;
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
				`Update Ollama and make sure experimental web search is enabled.${withBody}`,
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

async function waitForEndpointReady<T>(request: () => Promise<T>, host: string, timeoutMs: number, signal: AbortSignal | undefined): Promise<T> {
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
		: new Error(`Ollama ${OLLAMA_ENDPOINT} endpoint at ${host} did not become ready within ${startupTimeoutMs}ms.`);
}

async function readJsonResponse<T>(response: Response, host: string): Promise<T> {
	const body = await response.text().catch(() => "");

	if (!response.ok) throw createHttpError(response, host, body);
	if (!body.trim()) throw new Error(`Ollama ${OLLAMA_ENDPOINT} API at ${host} returned an empty response.`);

	try {
		return JSON.parse(body) as T;
	} catch (error) {
		const parseMessage = error instanceof Error ? error.message : String(error);
		const bodySuffix = formatErrorBody(body);
		throw new Error(`Ollama ${OLLAMA_ENDPOINT} API at ${host} returned invalid JSON: ${parseMessage}.${bodySuffix ? ` Body: ${bodySuffix}` : ""}`);
	}
}

function normalizeOllamaError(error: unknown, host: string, timeoutMs: number, timedOut: boolean, parentSignal: AbortSignal | undefined): Error {
	const apiName = OLLAMA_ENDPOINT;

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

async function postOllamaJson<T>(target: OllamaTarget, body: Record<string, unknown>, signal: AbortSignal | undefined, timeoutMs: number, retryEndpointUnavailable = true): Promise<T> {
	const { host } = target;
	const requestSignal = createRequestSignal(signal, timeoutMs);

	try {
		const response = await fetch(ollamaRequestUrl(target), {
			method: "POST",
			headers: {
				...(target.apiKey ? { Authorization: `Bearer ${target.apiKey}` } : {}),
				"Content-Type": "application/json",
			},
			body: JSON.stringify(body),
			signal: requestSignal.signal,
		});

		return await readJsonResponse<T>(response, host);
	} catch (error) {
		if (isConnectionRefused(error) && isLoopbackHost(host)) {
			requestSignal.cleanup();
			await ensureOllamaRunning(host, timeoutMs, signal);
			return waitForEndpointReady(() => postOllamaJson<T>(target, body, signal, timeoutMs, false), host, timeoutMs, signal);
		}

		if (retryEndpointUnavailable && isEndpointUnavailable(error) && isLoopbackHost(host)) {
			requestSignal.cleanup();
			return waitForEndpointReady(() => postOllamaJson<T>(target, body, signal, timeoutMs, false), host, timeoutMs, signal);
		}

		throw normalizeOllamaError(error, host, timeoutMs, requestSignal.timedOut(), signal);
	} finally {
		requestSignal.cleanup();
	}
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

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Tries providers in order; stops on success or parent cancellation. */
async function runSearchChain<T>(signal: AbortSignal | undefined, attempts: SearchAttempt<T>[]): Promise<ProviderResponse<T>> {
	const failures: Array<ProviderFailure & { label: string }> = [];

	for (const attempt of attempts) {
		try {
			const data = await attempt.request();
			if (failures.length === 0) return { data, provider: attempt.provider, host: attempt.host };
			return {
				data,
				provider: attempt.provider,
				host: attempt.host,
				fallbackFrom: { provider: failures[0].provider, error: failures[0].error },
				failures: failures.map(({ provider, error }) => ({ provider, error })),
			};
		} catch (error) {
			if (signal?.aborted) throw error;
			failures.push({ provider: attempt.provider, label: attempt.label, error: errorMessage(error) });
		}
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
 * Brave rejects Node/Bun TLS clients (HTTP 429) but serves curl, so the keyless fallback
 * shells out to the system curl without a shell; arguments are passed as an argv array.
 */
const curlTransport: BraveTransport = (url, signal) => new Promise((resolve, reject) => {
	const args = ["-sS", "--compressed", "--max-filesize", String(BRAVE_MAX_BYTES), "-w", `${STATUS_MARKER}%{http_code}`];
	for (const [name, value] of Object.entries(BRAVE_SEARCH_HEADERS)) args.push("-H", `${name}: ${value}`);
	args.push("--", url);
	const child = spawnImpl("curl", args, { stdio: ["ignore", "pipe", "pipe"], signal });
	const out: Buffer[] = [];
	const err: Buffer[] = [];
	let bytes = 0;
	child.stdout?.on("data", (chunk: Buffer) => {
		bytes += chunk.byteLength;
		if (bytes > BRAVE_MAX_BYTES + 64) child.kill();
		else out.push(chunk);
	});
	child.stderr?.on("data", (chunk: Buffer) => err.push(chunk));
	child.once("error", (error) => reject(errorIncludes(error, "ENOENT") ? new Error("curl is not installed; Brave Search fallback is unavailable.") : error));
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
		description: "Configure Ollama and Tavily API keys for web_search",
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

function searchResultDetails(response: ProviderResponse<SearchResponse>, timeoutMs: number, truncated: boolean) {
	return {
		results: response.data.results,
		resultCount: response.data.results.length,
		provider: response.provider,
		host: response.host,
		fallbackFrom: response.fallbackFrom,
		failures: response.failures,
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
			const ollamaTarget = resolveOllamaTarget();
			const tavilyApiKey = resolveApiKey(TAVILY_API_KEY_ENV, "tavily");
			const timeoutMs = resolveRequestTimeoutMs(params.timeout_ms);

			const attempts: SearchAttempt<SearchResponse>[] = [{
				provider: "ollama",
				label: `Ollama ${OLLAMA_ENDPOINT}`,
				host: ollamaTarget.host,
				request: async () => parseSearchResponse(await postOllamaJson<unknown>(ollamaTarget, { query: params.query, max_results: maxResults }, signal, timeoutMs)),
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
			attempts.push({
				provider: "brave",
				label: "Brave Search",
				host: BRAVE_SEARCH_HOST,
				request: () => searchBrave(params.query, maxResults, signal, timeoutMs),
			});

			const response = await runSearchChain(signal, attempts);
			if (response.fallbackFrom) suiteDiagnostics.report("warn", "web", "search-provider-fallback", ctx?.cwd);
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
