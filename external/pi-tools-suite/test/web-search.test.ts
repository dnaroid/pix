import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as childProcess from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const spawnCalls: Array<{ command: string; args: string[]; options: Record<string, unknown> }> = [];

type RegisteredTool = {
	name: string;
	execute: (toolCallId: string, params: Record<string, unknown>, signal?: AbortSignal) => Promise<{ content: Array<{ text: string }>; details?: Record<string, unknown> }>;
};

type RegisteredCommand = {
	handler: (args: string, ctx: any) => Promise<void>;
};

type FetchInput = Parameters<typeof fetch>[0];
type FetchInit = Parameters<typeof fetch>[1];
type FetchMock = (input: FetchInput, init?: FetchInit) => Promise<Response>;

const originalFetch = globalThis.fetch;
const originalOllamaHost = process.env.OLLAMA_HOST;
const originalOllamaApiKey = process.env.OLLAMA_API_KEY;
const originalTimeout = process.env.PI_WEB_SEARCH_TIMEOUT_MS;
const originalStartupTimeout = process.env.PI_WEB_SEARCH_OLLAMA_STARTUP_TIMEOUT_MS;
const originalTavilyApiKey = process.env.TAVILY_API_KEY;
const originalCredentialPath = process.env.PI_TOOLS_SUITE_WEB_CREDENTIALS_PATH;
const tempDirs: string[] = [];

function restoreEnv(name: "OLLAMA_HOST" | "OLLAMA_API_KEY" | "PI_WEB_SEARCH_TIMEOUT_MS" | "PI_WEB_SEARCH_OLLAMA_STARTUP_TIMEOUT_MS" | "TAVILY_API_KEY" | "PI_TOOLS_SUITE_WEB_CREDENTIALS_PATH", value: string | undefined) {
	if (value === undefined) delete process.env[name];
	else process.env[name] = value;
}

async function registeredWebSearch() {
	const { __setSpawnForTests, default: webSearch } = await import("../src/web-search/index.js");
	__setSpawnForTests(((command: string, ...rest: any[]) => {
		const args = Array.isArray(rest[0]) ? [...rest[0]] : [];
		const options = (Array.isArray(rest[0]) ? rest[1] : rest[0]) as childProcess.SpawnOptions | undefined;
		if (command !== "ollama") {
			if (args.length > 0) return options === undefined ? childProcess.spawn(command, args) : childProcess.spawn(command, args, options);
			return options === undefined ? childProcess.spawn(command) : childProcess.spawn(command, options);
		}
		spawnCalls.push({ command, args, options: (options ?? {}) as Record<string, unknown> });
		return {
			on: () => undefined,
			unref: () => undefined,
		} as unknown as ReturnType<typeof childProcess.spawn>;
	}) as typeof childProcess.spawn);
	const tools: RegisteredTool[] = [];
	const commands = new Map<string, RegisteredCommand>();
	webSearch({
		registerTool: (tool: RegisteredTool) => tools.push(tool),
		registerCommand: (name: string, command: RegisteredCommand) => commands.set(name, command),
	} as never);
	return {
		tools: Object.fromEntries(tools.map((tool) => [tool.name, tool])) as Record<"web_search" | "web_fetch", RegisteredTool>,
		commands,
	};
}

async function registeredTools() {
	return (await registeredWebSearch()).tools;
}

function mockFetch(handler: FetchMock) {
	globalThis.fetch = handler as unknown as typeof fetch;
}

async function expectRejectsWithMessage(promise: Promise<unknown>, expectedMessagePart: string) {
	try {
		await promise;
	} catch (error) {
		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).toContain(expectedMessagePart);
		return;
	}

	throw new Error(`Expected promise to reject with ${expectedMessagePart}`);
}

beforeEach(() => {
	const dir = mkdtempSync(join(tmpdir(), "pi-web-credentials-test-"));
	tempDirs.push(dir);
	process.env.PI_TOOLS_SUITE_WEB_CREDENTIALS_PATH = join(dir, "credentials.json");
	delete process.env.OLLAMA_HOST;
	delete process.env.OLLAMA_API_KEY;
	delete process.env.TAVILY_API_KEY;
	delete process.env.PI_WEB_SEARCH_TIMEOUT_MS;
	delete process.env.PI_WEB_SEARCH_OLLAMA_STARTUP_TIMEOUT_MS;
});

afterEach(async () => {
	globalThis.fetch = originalFetch;
	spawnCalls.length = 0;
	restoreEnv("OLLAMA_HOST", originalOllamaHost);
	restoreEnv("OLLAMA_API_KEY", originalOllamaApiKey);
	restoreEnv("PI_WEB_SEARCH_TIMEOUT_MS", originalTimeout);
	restoreEnv("PI_WEB_SEARCH_OLLAMA_STARTUP_TIMEOUT_MS", originalStartupTimeout);
	restoreEnv("TAVILY_API_KEY", originalTavilyApiKey);
	restoreEnv("PI_TOOLS_SUITE_WEB_CREDENTIALS_PATH", originalCredentialPath);
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	const { __setSpawnForTests } = await import("../src/web-search/index.js");
	__setSpawnForTests(undefined);
});

describe("web-search tools", () => {
	test("web-credentials stores an Ollama key securely and activates the cloud API immediately", async () => {
		const extension = await registeredWebSearch();
		const notifications: string[] = [];
		const storedKey = "ollama-test-secret";
		const credentialPath = process.env.PI_TOOLS_SUITE_WEB_CREDENTIALS_PATH!;
		await extension.commands.get("web-credentials")!.handler("", {
			hasUI: true,
			ui: {
				select: async () => "Set Ollama API key",
				input: async () => storedKey,
				notify: (message: string) => notifications.push(message),
			},
		});
		expect(notifications[0]).toContain("https://ollama.com/settings/keys");
		expect(notifications[0]).toContain("https://app.tavily.com/home");

		let request: { url: string; authorization: string | null } | undefined;
		mockFetch(async (url, init) => {
			request = {
				url: String(url),
				authorization: new Headers(init?.headers).get("Authorization"),
			};
			return new Response(JSON.stringify({ results: [] }), { status: 200 });
		});

		await extension.tools.web_search.execute("call-1", { query: "pi news" });

		expect(request).toEqual({
			url: "https://ollama.com/api/web_search",
			authorization: `Bearer ${storedKey}`,
		});
		expect(JSON.parse(readFileSync(credentialPath, "utf8"))).toEqual({ ollama: storedKey });
		if (process.platform !== "win32") expect(statSync(credentialPath).mode & 0o777).toBe(0o600);
		expect(notifications.join("\n")).not.toContain(storedKey);
	});

	test("web-credentials stores, reports, and clears a Tavily fallback key without displaying it", async () => {
		const extension = await registeredWebSearch();
		const notifications: string[] = [];
		let choice = "Set Tavily API key";
		const storedKey = "tvly-command-test-secret";
		const ctx = {
			hasUI: true,
			ui: {
				select: async () => choice,
				input: async () => storedKey,
				notify: (message: string) => notifications.push(message),
			},
		};
		const command = extension.commands.get("web-credentials")!;

		await command.handler("", ctx);
		choice = "Show credential status";
		await command.handler("", ctx);
		expect(notifications[notifications.length - 1]).toContain("Tavily: stored in pi-tools-suite credentials");

		const requests: Array<{ url: string; authorization: string | null }> = [];
		mockFetch(async (url, init) => {
			requests.push({ url: String(url), authorization: new Headers(init?.headers).get("Authorization") });
			if (String(url).includes("localhost")) return new Response("limit", { status: 429 });
			return new Response(JSON.stringify({ results: [] }), { status: 200 });
		});
		await extension.tools.web_search.execute("call-1", { query: "pi news" });
		expect(requests[1]).toEqual({ url: "https://api.tavily.com/search", authorization: `Bearer ${storedKey}` });

		choice = "Clear stored Tavily key";
		await command.handler("", ctx);
		expect(JSON.parse(readFileSync(process.env.PI_TOOLS_SUITE_WEB_CREDENTIALS_PATH!, "utf8"))).toEqual({});
		expect(notifications.join("\n")).not.toContain(storedKey);
	});

	test("web-credentials is headless-safe", async () => {
		const extension = await registeredWebSearch();
		let prompted = false;
		await extension.commands.get("web-credentials")!.handler("", {
			hasUI: false,
			ui: {
				select: async () => {
					prompted = true;
					return undefined;
				},
			},
		});

		expect(prompted).toBe(false);
	});

	test("web_search posts to normalized Ollama host and returns structured details", async () => {
		process.env.OLLAMA_HOST = "localhost:9999/";
		process.env.PI_WEB_SEARCH_TIMEOUT_MS = "1234";

		let request: { url: string; body: string; signal?: AbortSignal } | undefined;
		mockFetch(async (url, init) => {
			request = {
				url: String(url),
				body: String(init?.body),
				signal: init?.signal ?? undefined,
			};

			return new Response(
				JSON.stringify({
					results: [{ title: "Pi release", url: "https://example.com/pi", content: "Fresh news" }],
				}),
				{ status: 200 },
			);
		});

		const result = await (await registeredTools()).web_search.execute("call-1", { query: "pi news", max_results: 2 });

		expect(request?.url).toBe("http://localhost:9999/api/experimental/web_search");
		expect(JSON.parse(request?.body ?? "{}")).toEqual({ query: "pi news", max_results: 2 });
		expect(request?.signal).toBeInstanceOf(AbortSignal);
		expect(result.content[0]?.text).toContain("1. Pi release");
		expect(result.content[0]?.text).toContain("URL: https://example.com/pi");
		expect(result.details).toMatchObject({
			host: "http://localhost:9999",
			timeoutMs: 1234,
			resultCount: 1,
			truncated: false,
		});
	});

	test("web_fetch returns content/link metadata", async () => {
		mockFetch(async () =>
			new Response(
				JSON.stringify({
					title: "Example",
					content: "Hello from the page",
					links: ["https://example.com/a", "https://example.com/b"],
				}),
				{ status: 200 },
			));

		const result = await (await registeredTools()).web_fetch.execute("call-1", { url: "https://example.com" });

		expect(result.content[0]?.text).toContain("Title: Example");
		expect(result.content[0]?.text).toContain("Links found: 2");
		expect(result.details).toMatchObject({
			title: "Example",
			contentBytes: 19,
			linkCount: 2,
			host: "http://localhost:11434",
			timeoutMs: 30_000,
		});
		});

	test("web_search falls back to Tavily after an Ollama error", async () => {
		process.env.TAVILY_API_KEY = "tvly-test-secret";
		const requests: Array<{ url: string; authorization?: string; body: Record<string, unknown> }> = [];
		mockFetch(async (url, init) => {
			requests.push({
				url: String(url),
				authorization: new Headers(init?.headers).get("Authorization") ?? undefined,
				body: JSON.parse(String(init?.body)) as Record<string, unknown>,
			});

			if (String(url).includes("localhost")) {
				return new Response(JSON.stringify({ error: "usage limit exceeded" }), { status: 429 });
			}

			return new Response(
				JSON.stringify({
					results: [{ title: "Tavily result", url: "https://example.com/tavily", content: "Fallback worked" }],
				}),
				{ status: 200 },
			);
		});

		const result = await (await registeredTools()).web_search.execute("call-1", { query: "pi news", max_results: 50 });

		expect(requests).toHaveLength(2);
		expect(requests[0]).toMatchObject({
			url: "http://localhost:11434/api/experimental/web_search",
			body: { query: "pi news", max_results: 50 },
		});
		expect(requests[1]).toEqual({
			url: "https://api.tavily.com/search",
			authorization: "Bearer tvly-test-secret",
			body: { query: "pi news", max_results: 20, search_depth: "basic" },
		});
		expect(result.content[0]?.text).toContain("Tavily result");
		expect(result.details).toMatchObject({
			provider: "tavily",
			host: "https://api.tavily.com",
			resultCount: 1,
			fallbackFrom: {
				provider: "ollama",
				error: expect.stringContaining("HTTP 429"),
			},
		});
	});

	test("web_fetch falls back to Tavily Extract after an Ollama error", async () => {
		process.env.TAVILY_API_KEY = "tvly-test-secret";
		const targetUrl = "https://steamcommunity.com/sharedfiles/filedetails/?id=3038261866";
		const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
		mockFetch(async (url, init) => {
			requests.push({ url: String(url), body: JSON.parse(String(init?.body)) as Record<string, unknown> });

			if (String(url).includes("localhost")) {
				return new Response("upstream unavailable", { status: 503 });
			}

			return new Response(
				JSON.stringify({
					results: [{ url: targetUrl, raw_content: "# Steam Workshop\n\nExtracted by Tavily" }],
					failed_results: [],
				}),
				{ status: 200 },
			);
		});

		const result = await (await registeredTools()).web_fetch.execute("call-1", { url: targetUrl });

		expect(requests).toHaveLength(2);
		expect(requests[1]).toEqual({
			url: "https://api.tavily.com/extract",
			body: { urls: [targetUrl], extract_depth: "basic", format: "markdown" },
		});
		expect(result.content[0]?.text).toContain("Extracted by Tavily");
		expect(result.details).toMatchObject({
			provider: "tavily",
			host: "https://api.tavily.com",
			title: targetUrl,
			linkCount: 0,
			fallbackFrom: {
				provider: "ollama",
				error: expect.stringContaining("HTTP 503"),
			},
		});
	});

	test("reports Ollama auth errors with signin guidance", async () => {
		mockFetch(async () => new Response("auth required", { status: 401, statusText: "Unauthorized" }));

		await expectRejectsWithMessage((await registeredTools()).web_search.execute("call-1", { query: "latest pi" }), "ollama signin");
	});

	test("reports both failures without leaking the Tavily API key", async () => {
		process.env.TAVILY_API_KEY = "tvly-must-not-leak";
		mockFetch(async (url) => {
			if (String(url).includes("localhost")) return new Response("primary failed", { status: 500 });
			return new Response(JSON.stringify({ detail: { error: "invalid API key" } }), { status: 401 });
		});

		try {
			await (await registeredTools()).web_search.execute("call-1", { query: "latest pi" });
			throw new Error("Expected web_search to reject");
		} catch (error) {
			expect(error).toBeInstanceOf(Error);
			expect((error as Error).message).toContain("Ollama web_search failed");
			expect((error as Error).message).toContain("Tavily search fallback also failed");
			expect((error as Error).message).not.toContain("tvly-must-not-leak");
		}
	});

	test("reports a Tavily Extract failed_result", async () => {
		process.env.TAVILY_API_KEY = "tvly-test-secret";
		const targetUrl = "https://example.com/private-page";
		mockFetch(async (url) => {
			if (String(url).includes("localhost")) return new Response("primary failed", { status: 500 });
			return new Response(
				JSON.stringify({
					results: [],
					failed_results: [{ url: targetUrl, error: "Access denied by origin" }],
				}),
				{ status: 200 },
			);
		});

		await expectRejectsWithMessage(
			(await registeredTools()).web_fetch.execute("call-1", { url: targetUrl }),
			"Access denied by origin",
		);
	});

	test("does not start a Tavily fallback after parent cancellation", async () => {
		process.env.TAVILY_API_KEY = "tvly-test-secret";
		const controller = new AbortController();
		let requestCount = 0;
		mockFetch(async (_url, init) => {
			requestCount += 1;
			return new Promise<Response>((_resolve, reject) => {
				init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true });
			});
		});

		const pending = (await registeredTools()).web_search.execute("call-1", { query: "latest pi" }, controller.signal);
		controller.abort();

		await expectRejectsWithMessage(pending, "cancelled");
		expect(requestCount).toBe(1);
	});

	test("reports invalid JSON instead of leaking a generic parser error", async () => {
		mockFetch(async () => new Response("not json", { status: 200 }));

		await expectRejectsWithMessage((await registeredTools()).web_fetch.execute("call-1", { url: "https://example.com" }), "invalid JSON");
	});

	test("starts local Ollama and retries after connection refused", async () => {
		const error = new TypeError("fetch failed") as TypeError & { cause?: Error & { code?: string } };
		error.cause = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:11434"), { code: "ECONNREFUSED" });
		const urls: string[] = [];
		mockFetch(async () => {
			throw error;
		});
		mockFetch(async (url) => {
			urls.push(String(url));
			if (urls.length === 1) throw error;
			if (String(url).endsWith("/api/tags")) return new Response(JSON.stringify({ models: [] }), { status: 200 });
			return new Response(JSON.stringify({ results: [] }), { status: 200 });
		});

		const result = await (await registeredTools()).web_search.execute("call-1", { query: "latest pi" });

		expect(spawnCalls).toHaveLength(1);
		expect(spawnCalls[0]?.command).toBe("ollama");
		expect(spawnCalls[0]?.args).toEqual(["serve"]);
		expect(spawnCalls[0]?.options).toMatchObject({ detached: true, stdio: "ignore" });
		expect((spawnCalls[0]?.options.env as Record<string, string>).OLLAMA_HOST).toBe("http://localhost:11434");
		expect(urls).toEqual([
			"http://localhost:11434/api/experimental/web_search",
			"http://localhost:11434/api/tags",
			"http://localhost:11434/api/experimental/web_search",
		]);
		expect(result.content[0]?.text).toBe("No results found.");
	});

	test("waits and retries local endpoint 404s while Ollama web API is still becoming ready", async () => {
		const urls: string[] = [];
		mockFetch(async (url) => {
			urls.push(String(url));
			if (urls.length < 3) return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
			return new Response(
				JSON.stringify({
					title: "Example",
					content: "Ready now",
					links: [],
				}),
				{ status: 200 },
			);
		});

		const result = await (await registeredTools()).web_fetch.execute("call-1", { url: "https://example.com" });

		expect(spawnCalls).toHaveLength(0);
		expect(urls).toEqual([
			"http://localhost:11434/api/experimental/web_fetch",
			"http://localhost:11434/api/experimental/web_fetch",
			"http://localhost:11434/api/experimental/web_fetch",
		]);
		expect(result.content[0]?.text).toContain("Ready now");
	});

	test("does not try to spawn Ollama for remote hosts", async () => {
		process.env.OLLAMA_HOST = "https://ollama.example.com";
		const error = new TypeError("fetch failed") as TypeError & { cause?: Error & { code?: string } };
		error.cause = Object.assign(new Error("connect ECONNREFUSED 203.0.113.10:11434"), { code: "ECONNREFUSED" });
		mockFetch(async () => {
			throw error;
		});

		await expectRejectsWithMessage((await registeredTools()).web_search.execute("call-1", { query: "latest pi" }), "Could not connect to Ollama");
		expect(spawnCalls).toHaveLength(0);
	});

	test("times out stalled Ollama requests", async () => {
		mockFetch(async (_url, init) =>
			new Promise<Response>((_resolve, reject) => {
				init?.signal?.addEventListener(
					"abort",
					() => {
						const error = Object.assign(new Error("aborted"), { name: "AbortError" });
						reject(error);
					},
					{ once: true },
				);
			}));

		await expectRejectsWithMessage((await registeredTools()).web_fetch.execute("call-1", { url: "https://example.com", timeout_ms: 1 }), "timed out after 1ms");
	});
});
