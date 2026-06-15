import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { SessionManager, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import sessionTitle, { buildForkTitleInput, fallbackSessionTitleFromInput, firstUserMessageText, sessionTitleModelRefs } from "../src/bundled-extensions/session-title/index.js";

describe("session-title extension", () => {
	it("finds text from the first existing user message", () => {
		const ctx = fakeContext([
			{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "Hello" }] } },
			{ type: "message", message: { role: "user", content: [{ type: "text", text: "  Fix flaky title generation  " }] } },
			{ type: "message", message: { role: "user", content: [{ type: "text", text: "Second request" }] } },
		]);

		assert.equal(firstUserMessageText(ctx), "Fix flaky title generation");
	});

	it("joins text blocks and ignores non-text content", () => {
		const ctx = fakeContext([
			{
				type: "message",
				message: {
					role: "user",
					content: [
						{ type: "image", data: "..." },
						{ type: "text", text: "Analyze screenshot" },
						{ type: "text", text: "and fix UI state" },
					],
				},
			},
		]);

		assert.equal(firstUserMessageText(ctx), "Analyze screenshot\nand fix UI state");
	});

	it("supports legacy string message content", () => {
		const ctx = fakeContext([
			{ type: "message", message: { role: "user", content: "  Rename this session  " } },
		]);

		assert.equal(firstUserMessageText(ctx), "Rename this session");
	});

	it("builds fork title input from the parent title and fork prompt", () => {
		assert.equal(
			buildForkTitleInput("Implement Session Titles", "  Make fork names use the new prompt  "),
			[
				"Parent session title:",
				"Implement Session Titles",
				"",
				"First prompt in this fork:",
				"Make fork names use the new prompt",
			].join("\n"),
		);
	});

	it("falls back to the fork prompt when the parent title is unavailable", () => {
		assert.equal(buildForkTitleInput(undefined, "  Investigate crash  "), "Investigate crash");
	});

	it("builds a local fallback title from the first user words", () => {
		assert.equal(
			fallbackSessionTitleFromInput("  fix delayed session title refresh after model timeout in rust tui  ", 80),
			"fix delayed session title refresh after model timeout",
		);
	});

	it("truncates the fallback title to the configured character limit", () => {
		assert.equal(
			fallbackSessionTitleFromInput("Investigate intermittent title model outage and add a safer local fallback", 24),
			"Investigate intermittent",
		);
	});

	it("ignores leading punctuation in fallback titles", () => {
		assert.equal(
			fallbackSessionTitleFromInput("  --- \"\" Fix broken title retries now please  ", 80),
			"Fix broken title retries now please",
		);
	});

	it("tries configured fallback models after the primary title model", () => {
		assert.deepEqual(
			sessionTitleModelRefs({
				enabled: true,
				model: "zai/glm-5-turbo",
				fallbackModels: ["openai-codex/gpt-5.3-codex-spark", "zai/glm-5-turbo"],
				maxInputChars: 2000,
				maxTitleChars: 80,
				maxTokens: 32,
				maxRetries: 2,
				generationAttempts: 3,
				retryDelayMs: 3000,
				timeoutMs: 12_000,
				terminalTitle: true,
				terminalTitlePrefix: "pi — ",
				notify: false,
				debug: false,
			}),
			["zai/glm-5-turbo", "openai-codex/gpt-5.3-codex-spark"],
		);
	});

	it("does not generate a missing title from later prompts in an existing unnamed session", async () => {
		await withSessionTitleDisabled(async () => {
			const branch = [
				{ type: "message", message: { role: "user", content: [{ type: "text", text: "Original first request" }] } },
			];
			const { handlers, setSessionNameCalls } = createExtensionHarness({ branch, sessionName: undefined, sessionId: "session-existing" });

			sessionTitle(handlers.api);
			await handlers.session_start?.({ type: "session_start", reason: "resume" }, handlers.ctx);
			await handlers.input?.({ text: "A much later follow-up prompt", source: "user" }, handlers.ctx);

			assert.deepEqual(setSessionNameCalls, []);
		});
	});

	it("generates a fallback title from the very first prompt in a new session", async () => {
		await withSessionTitleDisabled(async () => {
			const { handlers, setSessionNameCalls } = createExtensionHarness({ branch: [], sessionName: undefined, sessionId: "session-new" });

			sessionTitle(handlers.api);
			await handlers.session_start?.({ type: "session_start", reason: "new" }, handlers.ctx);
			await handlers.input?.({ text: "Fix delayed session title refresh after startup", source: "user" }, handlers.ctx);

			assert.deepEqual(setSessionNameCalls, ["Fix delayed session title refresh after startup"]);
		});
	});

	it("generates a fallback title when the first prompt includes images", async () => {
		await withSessionTitleDisabled(async () => {
			const { handlers, setSessionNameCalls } = createExtensionHarness({ branch: [], sessionName: undefined, sessionId: "session-new-images" });

			sessionTitle(handlers.api);
			await handlers.session_start?.({ type: "session_start", reason: "new" }, handlers.ctx);
			await handlers.input?.({
				text: "Что не так на скриншоте?",
				images: [{ type: "image", data: "...", mimeType: "image/png" }],
				source: "interactive",
			}, handlers.ctx);

			assert.deepEqual(setSessionNameCalls, ["Что не так на скриншоте"]);
		});
	});

	it("generates a generic fallback title for an image-only first prompt", async () => {
		await withSessionTitleDisabled(async () => {
			const { handlers, setSessionNameCalls } = createExtensionHarness({ branch: [], sessionName: undefined, sessionId: "session-image-only" });

			sessionTitle(handlers.api);
			await handlers.session_start?.({ type: "session_start", reason: "new" }, handlers.ctx);
			await handlers.input?.({
				text: "",
				images: [{ type: "image", data: "...", mimeType: "image/png" }],
				source: "interactive",
			}, handlers.ctx);

			assert.deepEqual(setSessionNameCalls, ["Attached image"]);
		});
	});

	it("still regenerates the title from the first prompt after a fork", async () => {
		await withSessionTitleDisabled(async () => {
			const branch = [
				{ type: "message", message: { role: "user", content: [{ type: "text", text: "Parent session request" }] } },
			];
			const { handlers, setSessionNameCalls } = createExtensionHarness({
				branch,
				sessionName: "Parent session title",
				sessionId: "session-fork",
			});

			sessionTitle(handlers.api);
			await handlers.session_start?.({ type: "session_start", reason: "fork" }, handlers.ctx);
			await handlers.input?.({ text: "Investigate crash in fork", source: "user" }, handlers.ctx);

			assert.equal(setSessionNameCalls.length, 1);
			assert.notEqual(setSessionNameCalls[0], "Parent session title");
		});
	});

	it("does not touch a stale ctx after async fork startup work", async () => {
		await withSessionTitleDisabled(async () => {
			const originalOpen = SessionManager.open;
			const originalList = SessionManager.list;
			let stale = false;

			SessionManager.open = (() => {
				throw new Error("missing parent");
			}) as typeof SessionManager.open;
			SessionManager.list = (async () => {
				await Promise.resolve();
				stale = true;
				return [];
			}) as typeof SessionManager.list;

			try {
				const { handlers } = createExtensionHarness({
					branch: [],
					sessionName: "Parent session title",
					sessionId: "session-fork-stale",
					previousSessionFile: "/tmp/parent.jsonl",
					staleGuard: () => stale,
				});

				sessionTitle(handlers.api);
				await handlers.session_start?.({ type: "session_start", reason: "fork", previousSessionFile: "/tmp/parent.jsonl" }, handlers.ctx);
				await Promise.resolve();
			} finally {
				SessionManager.open = originalOpen;
				SessionManager.list = originalList;
			}
		});
	});

	it("ignores stale ctx in delayed UI refreshes scheduled from input", async () => {
		await withSessionTitleDisabled(async () => {
			let stale = false;
			const { handlers } = createExtensionHarness({
				branch: [],
				sessionName: undefined,
				sessionId: "session-stale-refresh",
				hasUI: true,
				staleGuard: () => stale,
			});

			sessionTitle(handlers.api);
			await handlers.session_start?.({ type: "session_start", reason: "new" }, handlers.ctx);
			await handlers.input?.({ text: "Refresh title after startup", source: "user" }, handlers.ctx);
			stale = true;
			await new Promise((resolve) => setTimeout(resolve, 10));
			await handlers.session_shutdown?.({ type: "session_shutdown", reason: "new" }, handlers.ctx);
		});
	});
});

function fakeContext(branch: unknown[]): ExtensionContext {
	return {
		sessionManager: {
			getBranch: () => branch,
		},
	} as unknown as ExtensionContext;
}

async function withSessionTitleDisabled<T>(callback: () => Promise<T>): Promise<T> {
	const previous = process.env.PI_SESSION_TITLE_ENABLED;
	process.env.PI_SESSION_TITLE_ENABLED = "0";
	try {
		return await callback();
	} finally {
		if (previous === undefined) delete process.env.PI_SESSION_TITLE_ENABLED;
		else process.env.PI_SESSION_TITLE_ENABLED = previous;
	}
}

function createExtensionHarness(options: {
	branch: unknown[];
	sessionName: string | undefined;
	sessionId: string;
	previousSessionFile?: string;
	hasUI?: boolean;
	staleGuard?: () => boolean;
}) {
	const handlers: Record<string, ((event: unknown, ctx: ExtensionContext) => unknown | Promise<unknown>) | undefined> = {};
	const setSessionNameCalls: string[] = [];
	let sessionName = options.sessionName;
	const staleGuard = options.staleGuard ?? (() => false);
	const assertFresh = () => {
		if (staleGuard()) throw new Error("stale ctx accessed");
	};
	const ctx = {
		cwd: process.cwd(),
		hasUI: options.hasUI ?? false,
		ui: {
			setTitle: () => {
				assertFresh();
			},
			notify: () => {
				assertFresh();
			},
		},
		sessionManager: {
			getBranch: () => options.branch,
			getSessionId: () => {
				assertFresh();
				return options.sessionId;
			},
			getSessionName: () => {
				assertFresh();
				return sessionName;
			},
			getHeader: () => {
				assertFresh();
				return options.previousSessionFile ? { parentSession: options.previousSessionFile } : undefined;
			},
			getSessionDir: () => {
				assertFresh();
				return process.cwd();
			},
		},
	} as unknown as ExtensionContext;

	const api = {
		on(event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown | Promise<unknown>) {
			handlers[event] = handler;
		},
		getSessionName: () => sessionName,
		setSessionName: (name: string) => {
			sessionName = name;
			setSessionNameCalls.push(name);
		},
	} as const;

	return {
		handlers: {
			api: api as never,
			ctx,
			get session_start() {
				return handlers.session_start;
			},
			get input() {
				return handlers.input;
			},
			get session_shutdown() {
				return handlers.session_shutdown;
			},
		},
		setSessionNameCalls,
	};
}
