import assert from "node:assert/strict";
import { it } from "node:test";
import type { AgentSession, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { installQuotaWaitControl, requestQuotaWaitControl } from "../src/app/session/quota-wait-control.js";

it("intercepts control envelopes before persistence and preserves normal custom messages", async () => {
	const saved: unknown[] = [];
	const session = { sendCustomMessage: async (message: unknown) => { saved.push(message); } } as Pick<AgentSession, "sendCustomMessage">;
	const actions: string[] = [];
	installQuotaWaitControl(session, (action) => { actions.push(action); return action === "pause"; });
	const pi = { sendMessage: (message: any) => { void session.sendCustomMessage(message); } } as ExtensionAPI;
	assert.equal(await requestQuotaWaitControl(pi, "pause"), true);
	assert.equal(await requestQuotaWaitControl(pi, "continue"), false);
	assert.deepEqual(actions, ["pause", "continue"]); assert.deepEqual(saved, []);
	await session.sendCustomMessage({ customType: "other", content: "hello", display: false });
	assert.equal(saved.length, 1);
	await session.sendCustomMessage({ customType: "pix-quota-control", content: "", display: false, details: {} });
	assert.equal(saved.length, 1);
});

it("reports a rejected continuation rather than leaking an unhandled rejection or transcript entry", async () => {
	const session = { sendCustomMessage: async () => { throw new Error("must not persist"); } } as Pick<AgentSession, "sendCustomMessage">;
	installQuotaWaitControl(session, async () => { throw new Error("session replaced"); });
	const pi = { sendMessage: (message: any) => { void session.sendCustomMessage(message); } } as ExtensionAPI;
	await assert.rejects(requestQuotaWaitControl(pi, "continue"), /session replaced/);
});
