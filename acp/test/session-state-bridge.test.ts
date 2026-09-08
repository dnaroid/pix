import assert from "node:assert/strict";
import { test } from "node:test";
import type { RpcExtensionUIRequest } from "@earendil-works/pi-coding-agent";
import {
	RPC_SESSION_STATE_WIDGET_KEY,
	sessionStateEnvelopeFromUiRequest,
} from "../src/acp/session-state-bridge.js";

function request(overrides: Partial<Extract<RpcExtensionUIRequest, { method: "setWidget" }>> = {}): RpcExtensionUIRequest {
	return {
		type: "extension_ui_request",
		id: "state-1",
		method: "setWidget",
		widgetKey: RPC_SESSION_STATE_WIDGET_KEY,
		widgetLines: ["pi-tools-suite:todo:state", JSON.stringify({ version: 1 })],
		...overrides,
	};
}

test("decodes a structured RPC session-state widget envelope", () => {
	assert.deepEqual(sessionStateEnvelopeFromUiRequest(request()), {
		channel: "pi-tools-suite:todo:state",
		data: { version: 1 },
	});
});

test("preserves optional nested subagent activity fields unchanged", () => {
	const data = {
		version: 1,
		count: 1,
		checkedAt: 1,
		runs: [{
			runDir: "/work/.pi/subagents/run-1",
			agents: [{
				id: "agent-1",
				status: "running",
				lastActivity: { label: "Grep", at: "2026-09-08T12:00:00.000Z" },
			}],
		}],
	};
	assert.deepEqual(sessionStateEnvelopeFromUiRequest(request({
		widgetLines: ["pi-tools-suite:async-subagents:live-state", JSON.stringify(data)],
	})), {
		channel: "pi-tools-suite:async-subagents:live-state",
		data,
	});
});

test("ignores ordinary widgets and malformed structured envelopes", () => {
	assert.equal(sessionStateEnvelopeFromUiRequest(request({ widgetKey: "extension-widget" })), undefined);
	assert.equal(sessionStateEnvelopeFromUiRequest(request({ widgetLines: ["channel"] })), undefined);
	assert.equal(sessionStateEnvelopeFromUiRequest(request({ widgetLines: ["channel", "not-json"] })), undefined);
	assert.equal(sessionStateEnvelopeFromUiRequest(request({ widgetLines: ["", "{}"] })), undefined);
});
