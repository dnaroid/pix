import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { client, PROTOCOL_VERSION } from "@agentclientprotocol/sdk";
import { PixAcpAgent } from "../src/acp/pix-acp-agent.js";
import { SessionMapStore } from "../src/acp/session-map.js";
import type { SubagentSessionState } from "../src/acp/subagent-sessions-contract.js";
import type { PiSessionState } from "../src/pi/pi-rpc-client.js";

const line = (value: unknown) => `${JSON.stringify(value)}\n`;

test("viewer open/state expose private todos and route-scoped quota without starting Pi or writing the child", async t => {
	const root = join(process.cwd(), ".pi", "artifacts", "subagent-viewer-status-tests");
	await mkdir(root, { recursive: true });
	const cwd = await realpath(await mkdtemp(join(root, "run-")));
	const scope = "0199f0c2-4444-7222-8333-944445555666";
	const scopeDir = join(cwd, ".pi", "subagents", scope);
	const runDir = join(scopeDir, "batch");
	await mkdir(scopeDir, { recursive: true });
	const parent = join(cwd, "parent.jsonl");
	const child = join(scopeDir, "child.jsonl");
	const details = { action: "create", params: {}, tasks: [{ id: 1, subject: "Private child task", status: "in_progress" }], nextId: 2 };
	await writeFile(parent, line({ type: "session", id: scope, cwd }));
	await writeFile(child, line({ type: "session", id: "child", cwd })
		+ line({ type: "custom", customType: "subagent_meta", data: {
			version: 1, agentId: "child", batch: "batch", scope, cwd, runDir, parentSession: parent,
		} })
		+ line({ type: "model_change", provider: "zai", modelId: "glm-child" })
		+ line({ type: "thinking_level_change", thinkingLevel: "high" })
		+ line({ type: "custom", customType: "pi-tools-suite:todo-state", data: details }));
	const original = await readFile(child, "utf8");
	const queries: PiSessionState[] = [];
	const warnings: string[] = [];
	const logger = { debug() {}, info() {}, warn: (message: string) => { warnings.push(message); }, error() {} };
	const sessionMapPath = join(cwd, "sessions.json");
	const agent = new PixAcpAgent({
		piEntry: "/test/unused.js", logger, sessionMapPath, agentDir: join(cwd, "agent"),
		createPiClient: () => { throw new Error("Viewer must never start Pi"); },
		queryModelUsage: async state => {
			queries.push(state);
			if (state.model?.provider === "other") throw new Error("quota fixture unavailable");
			return { refresh: "ready", status: { modelKey: "zai/glm-child", provider: "zhipu", updatedAt: 1,
				hourly: { remainingPercent: 75, resetAt: Date.now() + 60_000, windowSeconds: 3600 } } };
		},
	});
	t.after(async () => { await agent.dispose(); await rm(cwd, { recursive: true, force: true }); });
	const map = new SessionMapStore(sessionMapPath, logger);
	await map.put({ sessionId: "parent", piSessionPath: parent, piSessionId: scope, cwd, updatedAt: new Date().toISOString() });
	await client({ name: "pix-desktop" }).connectWith(agent.acpApp, async cx => {
		await cx.request("initialize", { protocolVersion: PROTOCOL_VERSION, clientInfo: { name: "pix-desktop", version: "test" } });
		const opened = await cx.request("pix/subagents/open_session", { sessionId: "parent", runDir, agentId: "child" }) as SubagentSessionState & { sessionId: string };
		assert.deepEqual(opened.todo?.details, details);
		assert.equal(opened.modelUsage?.modelKey, "zai/glm-child");
		assert.equal(opened.modelUsageRefresh, "ready");
		assert.equal(opened.model?.modelId, "glm-child");
		assert.equal(queries[0]?.thinkingLevel, "high");
		assert.equal(queries[0]?.sessionId, "child");
		await cx.request("pix/subagents/session_state", { sessionId: opened.sessionId });
		assert.equal(queries.length, 1, "2s viewer polls must not repeatedly query provider quotas");
		assert.equal(await readFile(child, "utf8"), original, "viewing never mutates the child session");
		await appendFile(child, line({ type: "model_change", provider: "other", modelId: "changed" })
			+ line({ type: "custom", customType: "pi-tools-suite:todo-state", data: { ...details, action: "clear", tasks: [] } }));
		const changed = await cx.request("pix/subagents/session_state", { sessionId: opened.sessionId }) as SubagentSessionState;
		assert.equal(changed.model?.provider, "other");
		assert.equal(changed.modelUsageRefresh, "failed");
		assert.equal(changed.modelUsage, undefined, "a new model cannot inherit the old route's limits");
		assert.deepEqual(changed.todo?.details.tasks, [], "quota failure must not hide plan updates");
		assert.equal(queries.length, 2);
		assert.ok(warnings.some(message => message.includes("quota fixture unavailable")));
	});
	assert.equal(agent.sessionCount, 0);
});
