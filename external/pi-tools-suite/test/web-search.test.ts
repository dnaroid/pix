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
	const { __setSpawnForTests, __setBraveTransportForTests, default: webSearch } = await import("../src/web-search/index.js");
	// Route the curl-based Brave transport through the fetch mock.
	__setBraveTransportForTests(async (url, signal) => {
		const response = await globalThis.fetch(url, { signal });
		return { status: response.status, body: await response.text() };
	});
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

	test("web_search falls back to keyless Brave Search HTML when Ollama fails and no Tavily key exists", async () => {
		const requests: Array<{ url: string; authorization?: string }> = [];
		const braveHtml = `<html><body><main><section id="mixed-main">
			<div class="snippet svelte-x" data-pos="0" data-type="web"><a href="https://example.com/one"><div class="title search-snippet-title" title="First &amp; best">First</div></a>
				<div class="generic-snippet"><div class="content">Snippet <strong>one</strong></div></div></div>
			<div class="snippet svelte-x" data-pos="1" data-type="web"><a href="https://example.com/two"><div class="title">Second</div></a></div>
			<div class="snippet svelte-x" data-pos="2" data-type="web"><a href="https://example.com/three"><div class="title">Third</div></a></div>
		</section></main></body></html>`;
		mockFetch(async (url, init) => {
			requests.push({ url: String(url), authorization: new Headers(init?.headers).get("Authorization") ?? undefined });
			if (String(url).includes("localhost")) return new Response("limit", { status: 429 });
			return new Response(braveHtml, { status: 200, headers: { "Content-Type": "text/html" } });
		});

		const result = await (await registeredTools()).web_search.execute("call-1", { query: "pi news", max_results: 2 });

		expect(requests).toHaveLength(2);
		expect(requests[1]?.url).toBe("https://search.brave.com/search?q=pi+news&source=web");
		expect(requests[1]?.authorization).toBeUndefined();
		expect(result.content[0]?.text).toContain("1. First & best\n   URL: https://example.com/one\n   Snippet one");
		expect(result.content[0]?.text).not.toContain("Third");
		expect(result.details).toMatchObject({
			provider: "brave",
			host: "https://search.brave.com",
			resultCount: 2,
			fallbackFrom: { provider: "ollama", error: expect.stringContaining("HTTP 429") },
		});
	});

	test("web_search tries Brave after Tavily and reports all three failures on a CAPTCHA page", async () => {
		process.env.TAVILY_API_KEY = "tvly-must-not-leak";
		const urls: string[] = [];
		mockFetch(async (url) => {
			urls.push(String(url));
			if (String(url).includes("localhost")) return new Response("primary failed", { status: 500 });
			if (String(url).includes("tavily")) return new Response("{}", { status: 432 });
			return new Response("<html><body>Please solve the captcha</body></html>", { status: 200 });
		});

		try {
			await (await registeredTools()).web_search.execute("call-1", { query: "latest pi" });
			throw new Error("Expected web_search to reject");
		} catch (error) {
			const message = (error as Error).message;
			expect(message).toContain("Ollama web_search failed");
			expect(message).toContain("Tavily search fallback also failed");
			expect(message).toContain("Brave Search fallback also failed");
			expect(message).toContain("possible CAPTCHA");
			expect(message).not.toContain("tvly-must-not-leak");
		}
		expect(urls.map((url) => new URL(url).host)).toEqual(["localhost:11434", "api.tavily.com", "search.brave.com"]);
	});

	test("web_fetch rejects unsupported targets and honours cancellation without using search providers", async () => {
		process.env.OLLAMA_API_KEY = "search-ollama-key";
		process.env.TAVILY_API_KEY = "search-tavily-key";
		const requests: string[] = [];
		mockFetch(async (url) => {
			requests.push(String(url));
			throw new Error("Unexpected provider call");
		});
		const { web_fetch: tool } = await registeredTools();
		for (const url of ["file:///tmp/page", "https://user:pass@1.1.1.1/"]) {
			await expectRejectsWithMessage(tool.execute("call-1", { url }), "public HTTP(S) URL without embedded credentials");
		}
		await expectRejectsWithMessage(tool.execute("call-2", { url: "http://127.0.0.1/" }), "private or reserved");
		await expectRejectsWithMessage(tool.execute("call-3", { url: "https://example.com" }, AbortSignal.abort()), "was cancelled");
		expect(requests).toEqual([]);
		expect(spawnCalls).toEqual([]);
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

		await expectRejectsWithMessage((await registeredTools()).web_search.execute("call-1", { query: "latest pi" }), "invalid JSON");
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
					results: [{ title: "Ready now", url: "https://example.com" }],
				}),
				{ status: 200 },
			);
		});

		const result = await (await registeredTools()).web_search.execute("call-1", { query: "latest pi" });

		expect(spawnCalls).toHaveLength(0);
		expect(urls).toEqual([
			"http://localhost:11434/api/experimental/web_search",
			"http://localhost:11434/api/experimental/web_search",
			"http://localhost:11434/api/experimental/web_search",
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

		await expectRejectsWithMessage((await registeredTools()).web_search.execute("call-1", { query: "latest pi", timeout_ms: 1 }), "timed out after 1ms");
	});
});
