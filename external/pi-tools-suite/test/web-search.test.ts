import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";


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
const originalTimeout = process.env.PI_WEB_SEARCH_TIMEOUT_MS;
const originalTavilyApiKey = process.env.TAVILY_API_KEY;
const originalCredentialPath = process.env.PI_TOOLS_SUITE_WEB_CREDENTIALS_PATH;
const tempDirs: string[] = [];

function restoreEnv(name: "PI_WEB_SEARCH_TIMEOUT_MS" | "TAVILY_API_KEY" | "PI_TOOLS_SUITE_WEB_CREDENTIALS_PATH", value: string | undefined) {
	if (value === undefined) delete process.env[name];
	else process.env[name] = value;
}

async function registeredWebSearch(braveFetch: FetchMock = async () => new Response('<main id="mixed-main"></main>')) {
	const { __setBraveTransportForTests, default: webSearch } = await import("../src/web-search/index.js");
	// Default to an empty Brave page for tests exercising downstream providers.
	__setBraveTransportForTests(async (url, signal) => {
		const response = await braveFetch(url, { signal });
		return { status: response.status, body: await response.text() };
	});
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

async function registeredTools(braveFetch?: FetchMock) {
	return (await registeredWebSearch(braveFetch)).tools;
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
	delete process.env.TAVILY_API_KEY;
	delete process.env.PI_WEB_SEARCH_TIMEOUT_MS;
});

afterEach(async () => {
	globalThis.fetch = originalFetch;
	restoreEnv("PI_WEB_SEARCH_TIMEOUT_MS", originalTimeout);
	restoreEnv("TAVILY_API_KEY", originalTavilyApiKey);
	restoreEnv("PI_TOOLS_SUITE_WEB_CREDENTIALS_PATH", originalCredentialPath);
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("web-search tools", () => {
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
		const credentialPath = process.env.PI_TOOLS_SUITE_WEB_CREDENTIALS_PATH!;
		writeFileSync(credentialPath, JSON.stringify({ ollama: "unused-legacy-key" }));

		await command.handler("", ctx);
		if (process.platform !== "win32") expect(statSync(credentialPath).mode & 0o777).toBe(0o600);
		choice = "Show credential status";
		await command.handler("", ctx);
		expect(notifications[notifications.length - 1]).toContain("Tavily: stored in pi-tools-suite credentials");

		const requests: Array<{ url: string; authorization: string | null }> = [];
		mockFetch(async (url, init) => {
			requests.push({ url: String(url), authorization: new Headers(init?.headers).get("Authorization") });
			return new Response(JSON.stringify({ results: [] }), { status: 200 });
		});
		await extension.tools.web_search.execute("call-1", { query: "pi news" });
		expect(requests).toEqual([{ url: "https://api.tavily.com/search", authorization: `Bearer ${storedKey}` }]);

		choice = "Clear stored Tavily key";
		await command.handler("", ctx);
		expect(JSON.parse(readFileSync(credentialPath, "utf8"))).toEqual({ ollama: "unused-legacy-key" });
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

	test("web_search uses keyless Brave first and skips Tavily on a hit", async () => {
		process.env.TAVILY_API_KEY = "tvly-test-secret";
		const requests: Array<{ url: string; authorization?: string }> = [];
		const braveHtml = `<html><body><main><section id="mixed-main">
			<div class="snippet svelte-x" data-pos="0" data-type="web"><a href="https://example.com/one"><div class="title search-snippet-title" title="First &amp; best">First</div></a>
				<div class="generic-snippet"><div class="content">Snippet <strong>one</strong></div></div></div>
			<div class="snippet svelte-x" data-pos="1" data-type="web"><a href="https://example.com/two"><div class="title">Second</div></a></div>
			<div class="snippet svelte-x" data-pos="2" data-type="web"><a href="https://example.com/three"><div class="title">Third</div></a></div>
		</section></main></body></html>`;
		mockFetch(async (url, init) => {
			requests.push({ url: String(url), authorization: new Headers(init?.headers).get("Authorization") ?? undefined });
			throw new Error("Unexpected fallback request");
		});

		const tools = await registeredTools(async (url, init) => {
			requests.push({ url: String(url), authorization: new Headers(init?.headers).get("Authorization") ?? undefined });
			return new Response(braveHtml);
		});
		const result = await tools.web_search.execute("call-1", { query: "pi news", max_results: 2 });

		expect(requests).toEqual([{ url: "https://search.brave.com/search?q=pi+news&source=web", authorization: undefined }]);
		expect(result.content[0]?.text).toContain("1. First & best\n   URL: https://example.com/one\n   Snippet one");
		expect(result.content[0]?.text).not.toContain("Third");
		expect(result.details).toMatchObject({
			provider: "brave",
			host: "https://search.brave.com",
			resultCount: 2,
			emptyProviders: [],
		});
	});

	test("web_search continues past empty Brave results to Tavily", async () => {
		process.env.TAVILY_API_KEY = "tvly-test-secret";
		const hosts: string[] = [];
		mockFetch(async (url) => {
			const host = new URL(String(url)).hostname;
			hosts.push(host);
			return Response.json({ results: [{ url: "https://example.com", title: "Tavily hit" }] });
		});

		const tools = await registeredTools(async (url) => {
			hosts.push(new URL(String(url)).hostname);
			return new Response('<main id="mixed-main"></main>');
		});
		const result = await tools.web_search.execute("call-1", { query: "pi news" });

		expect(hosts).toEqual(["search.brave.com", "api.tavily.com"]);
		expect(result.content[0]?.text).toStartWith("Provider: tavily\n\n1. Tavily hit");
		expect(result.details).toMatchObject({ provider: "tavily", resultCount: 1, emptyProviders: ["brave"] });
		expect(result.details?.failures).toBeUndefined();
	});

	test("web_search makes no fallback request without a Tavily key", async () => {
		writeFileSync(process.env.PI_TOOLS_SUITE_WEB_CREDENTIALS_PATH!, JSON.stringify({ ollama: "unused-legacy-key" }));
		const requests: string[] = [];
		mockFetch(async (url) => {
			requests.push(String(url));
			throw new Error("Unexpected fallback request");
		});

		const result = await (await registeredTools()).web_search.execute("call-1", { query: "pi news" });

		expect(requests).toEqual([]);
		expect(result.content[0]?.text).toBe("Provider: brave\n\nNo results found.");
		expect(result.details).toMatchObject({ provider: "brave", resultCount: 0, emptyProviders: ["brave"] });
	});

	test("web_search preserves an empty response when Tavily fails", async () => {
		process.env.TAVILY_API_KEY = "tvly-test-secret";
		mockFetch(async () => new Response("rate limit", { status: 429 }));

		const result = await (await registeredTools()).web_search.execute("call-1", { query: "pi news" });

		expect(result.content[0]?.text).toBe("Provider: brave\n\nNo results found.");
		expect(result.details).toMatchObject({
			provider: "brave",
			resultCount: 0,
			emptyProviders: ["brave"],
			failures: [{ provider: "tavily", error: expect.stringContaining("429") }],
		});
	});

	test("web_search falls back after a Brave CAPTCHA and reports both failures in order", async () => {
		process.env.TAVILY_API_KEY = "tvly-must-not-leak";
		const urls: string[] = [];
		mockFetch(async (url) => {
			urls.push(String(url));
			return new Response("{}", { status: 432 });
		});
		const tools = await registeredTools(async (url) => {
			urls.push(String(url));
			return new Response("<html><body>Please solve the captcha</body></html>", { status: 200 });
		});

		try {
			await tools.web_search.execute("call-1", { query: "latest pi" });
			throw new Error("Expected web_search to reject");
		} catch (error) {
			const message = (error as Error).message;
			expect(message).toContain("Tavily search fallback also failed");
			expect(message).toStartWith("Brave Search failed");
			expect(message).toContain("possible CAPTCHA");
			expect(message).not.toContain("tvly-must-not-leak");
		}
		expect(urls.map((url) => new URL(url).host)).toEqual(["search.brave.com", "api.tavily.com"]);
	});

	test("web_fetch rejects unsupported targets and honours cancellation without using search providers", async () => {
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
	});

	test("does not start a fallback after cancellation during Brave", async () => {
		process.env.TAVILY_API_KEY = "tvly-test-secret";
		const controller = new AbortController();
		let requestCount = 0;
		mockFetch(async (_url, init) => {
			requestCount += 1;
			return new Promise<Response>((_resolve, reject) => {
				init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true });
			});
		});

		const pending = (await registeredTools(globalThis.fetch)).web_search.execute("call-1", { query: "latest pi" }, controller.signal);
		controller.abort();

		await expectRejectsWithMessage(pending, "cancelled");
		expect(requestCount).toBe(1);
	});
});
