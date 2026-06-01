import { afterEach, describe, expect, test } from "bun:test";

import webSearch from "../src/web-search/index.js";

type RegisteredTool = {
	name: string;
	execute: (toolCallId: string, params: Record<string, unknown>, signal?: AbortSignal) => Promise<{ content: Array<{ text: string }>; details?: Record<string, unknown> }>;
};

type FetchInput = Parameters<typeof fetch>[0];
type FetchInit = Parameters<typeof fetch>[1];
type FetchMock = (input: FetchInput, init?: FetchInit) => Promise<Response>;

const originalFetch = globalThis.fetch;
const originalOllamaHost = process.env.OLLAMA_HOST;
const originalTimeout = process.env.PI_WEB_SEARCH_TIMEOUT_MS;

function restoreEnv(name: "OLLAMA_HOST" | "PI_WEB_SEARCH_TIMEOUT_MS", value: string | undefined) {
	if (value === undefined) delete process.env[name];
	else process.env[name] = value;
}

function registeredTools() {
	const tools: RegisteredTool[] = [];
	webSearch({ registerTool: (tool: RegisteredTool) => tools.push(tool) } as never);
	return Object.fromEntries(tools.map((tool) => [tool.name, tool])) as Record<"web_search" | "web_fetch", RegisteredTool>;
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

afterEach(() => {
	globalThis.fetch = originalFetch;
	restoreEnv("OLLAMA_HOST", originalOllamaHost);
	restoreEnv("PI_WEB_SEARCH_TIMEOUT_MS", originalTimeout);
});

describe("web-search tools", () => {
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

		const result = await registeredTools().web_search.execute("call-1", { query: "pi news", max_results: 2 });

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

		const result = await registeredTools().web_fetch.execute("call-1", { url: "https://example.com" });

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

	test("reports Ollama auth errors with signin guidance", async () => {
		mockFetch(async () => new Response("auth required", { status: 401, statusText: "Unauthorized" }));

		await expectRejectsWithMessage(registeredTools().web_search.execute("call-1", { query: "latest pi" }), "ollama signin");
	});

	test("reports invalid JSON instead of leaking a generic parser error", async () => {
		mockFetch(async () => new Response("not json", { status: 200 }));

		await expectRejectsWithMessage(registeredTools().web_fetch.execute("call-1", { url: "https://example.com" }), "invalid JSON");
	});

	test("maps connection refused to an Ollama startup hint", async () => {
		const error = new TypeError("fetch failed") as TypeError & { cause?: Error & { code?: string } };
		error.cause = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:11434"), { code: "ECONNREFUSED" });
		mockFetch(async () => {
			throw error;
		});

		await expectRejectsWithMessage(registeredTools().web_search.execute("call-1", { query: "latest pi" }), "Could not connect to Ollama");
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

		await expectRejectsWithMessage(registeredTools().web_fetch.execute("call-1", { url: "https://example.com", timeout_ms: 1 }), "timed out after 1ms");
	});
});
