import { afterEach, describe, expect, test } from "bun:test";
import type { ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { createBrainstormRunner, desktopCouncilConnection, desktopCouncilTerminal } from "../../src/brainstorm/desktop-sessions.js";

const servers: ReturnType<typeof Bun.serve>[] = [];
afterEach(() => { for (const server of servers.splice(0)) server.stop(true); });
function host(handler: (request: Request) => Response | Promise<Response>) {
	const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: handler });
	servers.push(server);
	return { url: `http://127.0.0.1:${server.port}/`, token: "test-capability" };
}
const ctx = { cwd: "/test", tools: [], ui: { notify() {} } } as unknown as ExtensionToolContext;
const input = {
	runId: "abcdef123456", runDir: "/test/.pi/brainstorms/run-abcdef123456", topic: "Storage", round: 1 as const,
	execution: "desktop-sessions" as const,
	tasks: [{ id: "round-1-participant-1", model: "vendor/a", task: "Independent proposal", thinking: "high", timeoutSeconds: 30 }],
};

describe("Desktop council capability adapter", () => {
	test("rejects partial, remote and credential-bearing endpoints instead of falling back", () => {
		expect(desktopCouncilConnection({})).toBeUndefined();
		for (const env of [
			{ PIX_BRAINSTORM_HOST_TOKEN: "secret" },
			{ PIX_BRAINSTORM_HOST_URL: "http://127.0.0.1:1234/" },
			... ["https://example.com/", "http://localhost:1234/", "http://127.0.0.1:1234/?token=secret", "http://secret@127.0.0.1:1234/"].map((url) => ({ PIX_BRAINSTORM_HOST_URL: url, PIX_BRAINSTORM_HOST_TOKEN: "secret" })),
		]) expect(() => desktopCouncilConnection(env)).toThrow();
	});
	test("uses one scoped host for rounds and review; does not require nested subagents", async () => {
		const requests: Record<string, unknown>[] = [];
		const connection = host(async (request) => {
			expect(request.headers.get("authorization")).toBe("Bearer test-capability");
			requests.push(await request.json());
			return Response.json({ responses: [], missing: [] });
		});
		const runner = createBrainstormRunner(ctx, connection);
		expect(runner.execution).toBe("desktop-sessions");
		for (const round of [1, 2, 3, 4, 5] as const) await runner({ ...input, round });
		expect(requests.map((body) => body.round)).toEqual([1, 2, 3, 4, 5]);
		expect(new Set(requests.map((body) => body.runId)).size).toBe(1);
		expect(requests[0]).toEqual({ action: "round", runId: input.runId, runDir: input.runDir, topic: input.topic, round: 1, tasks: input.tasks });
		expect(() => runner.validateExecution?.(undefined)).toThrow("async-subagents");
	});
	test("refuses a persistent continuation without its host", () => {
		// No capability is the ordinary TUI environment in this test process.
		expect(() => createBrainstormRunner(ctx).validateExecution?.("desktop-sessions")).toThrow("original Desktop session host");
	});
	test("propagates cancellation and rejects redirects, oversize and error responses", async () => {
		const cancelled = createBrainstormRunner(ctx, host(() => Response.json({ responses: [] })));
		await expect(cancelled({ ...input, signal: AbortSignal.abort() })).rejects.toThrow();
		for (const response of [
			() => Response.json({ error: "owned by a different orchestrator" }, { status: 403 }),
			() => new Response("x".repeat(2 * 1024 * 1024 + 1)),
			() => Response.redirect("http://example.com"),
		]) await expect(createBrainstormRunner(ctx, host(response))(input)).rejects.toThrow();
	});
	test("terminal notification has its own deadline, reports failure without undoing finalization", async () => {
		const seen: unknown[] = [];
		const warnings: string[] = [];
		const connection = host(async (request) => { seen.push(await request.json()); return Response.json({}); });
		await desktopCouncilTerminal((message) => warnings.push(message), connection)(input.runId, "complete");
		expect(seen).toEqual([{ action: "finish", runId: input.runId, status: "complete" }]);
		await desktopCouncilTerminal((message) => warnings.push(message), host(() => Response.json({ error: "host lost" }, { status: 409 })))(input.runId, "incomplete");
		expect(warnings).toHaveLength(1);
	});
});
