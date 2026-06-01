import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const originalFetch = globalThis.fetch;
const tempDirs: string[] = [];

class FakePi {
	providers = new Map<string, any>();
	messages: any[] = [];
	registerMessageRenderer() {}
	registerCommand() {}
	registerProvider(name: string, provider: any) { this.providers.set(name, provider); }
	sendMessage(message: any) { this.messages.push(message); }
}

function tempDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "antigravity-auth-test-"));
	tempDirs.push(dir);
	return dir;
}

function writeJson(file: string, data: unknown): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, JSON.stringify(data, null, 2), "utf-8");
}

function antigravityCredential(overrides: Record<string, unknown> = {}) {
	return {
		type: "oauth",
		access: "access-0|project-0",
		refresh: "refresh-0|project-0",
		expires: Date.now() + 60_000,
		email: "first@example.com",
		activeIndex: 0,
		accounts: [
			{ email: "first@example.com", refreshToken: "refresh-0", projectId: "project-0" },
			{ email: "second@example.com", refreshToken: "refresh-1", projectId: "project-1" },
		],
		...overrides,
	};
}

async function loadProvider(agentDir: string) {
	process.env.PI_CODING_AGENT_DIR = agentDir;
	const { default: antigravityAuth } = await import("../src/antigravity-auth/index.js");
	const pi = new FakePi();
	await antigravityAuth(pi as any);
	const provider = pi.providers.get("antigravity");
	const modelDef = provider.models.find((model: any) => model.id === "gemini-3-flash-preview");
	const model = { ...modelDef, provider: "antigravity", api: provider.api, baseUrl: provider.baseUrl };
	return { pi, provider, model };
}

async function runSimpleStream(provider: any, model: any) {
	const stream = provider.streamSimple(model, {
		messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
	});
	return await stream.result();
}

afterEach(() => {
	if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
	globalThis.fetch = originalFetch;
	for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe.serial("Antigravity account rotation", () => {
	test.serial("emits all-accounts-exhausted marker only after trying every account for the model", async () => {
		const agentDir = tempDir();
		writeJson(path.join(agentDir, "auth.json"), { antigravity: antigravityCredential() });
		const streamAuthorizations: string[] = [];
		const tokenRefreshes: string[] = [];
		(globalThis as any).fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input);
			if (url === "https://oauth2.googleapis.com/token") {
				const body = init?.body instanceof URLSearchParams ? init.body : new URLSearchParams(String(init?.body ?? ""));
				tokenRefreshes.push(body.get("refresh_token") ?? "");
				return new Response(JSON.stringify({ access_token: "access-1", expires_in: 3600 }), { status: 200, headers: { "content-type": "application/json" } });
			}
			if (url.includes("/v1internal:streamGenerateContent")) {
				streamAuthorizations.push(new Headers(init?.headers as HeadersInit).get("authorization") ?? "");
				return new Response("quota exceeded", { status: 429 });
			}
			throw new Error(`Unexpected fetch ${url}`);
		};

		const { pi, provider, model } = await loadProvider(agentDir);
		const result = await runSimpleStream(provider, model);

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("ANTIGRAVITY_ALL_ACCOUNTS_EXHAUSTED");
		expect(result.errorMessage).toContain("model=gemini-3-flash-preview");
		expect(streamAuthorizations).toEqual(["Bearer access-0", "Bearer access-1"]);
		expect(tokenRefreshes).toEqual(["refresh-1"]);
		expect(pi.messages.filter((message) => message.details?.kind === "switch")).toHaveLength(1);
		expect(JSON.parse(fs.readFileSync(path.join(agentDir, "auth.json"), "utf-8")).antigravity.activeIndex).toBe(1);
	});

	test.serial("does not emit fallback marker for non-limit capacity failures after rotation is exhausted", async () => {
		const agentDir = tempDir();
		writeJson(path.join(agentDir, "auth.json"), { antigravity: antigravityCredential() });
		let streamRequests = 0;
		(globalThis as any).fetch = async (input: RequestInfo | URL, _init?: RequestInit) => {
			const url = String(input);
			if (url === "https://oauth2.googleapis.com/token") {
				return new Response(JSON.stringify({ access_token: "access-1", expires_in: 3600 }), { status: 200, headers: { "content-type": "application/json" } });
			}
			if (url.includes("/v1internal:streamGenerateContent")) {
				streamRequests += 1;
				return new Response("server busy", { status: 503 });
			}
			throw new Error(`Unexpected fetch ${url}`);
		};

		const { provider, model } = await loadProvider(agentDir);
		const result = await runSimpleStream(provider, model);

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("Antigravity request failed (503)");
		expect(result.errorMessage).not.toContain("ANTIGRAVITY_ALL_ACCOUNTS_EXHAUSTED");
		expect(streamRequests).toBe(2);
	});
});
