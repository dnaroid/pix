import assert from "node:assert/strict";
import { test } from "node:test";

import {
	PIX_GIT_ASSIST_METHOD,
	PIX_REGISTRY_ACTION_METHOD,
	PIX_TOOL_RESULT_METHOD,
	parseDesktopGitAssistantRequest,
	parseDesktopRegistryActionRequest,
	parseDesktopToolResultRequest,
} from "../src/acp/desktop-commands.js";

test("desktop tool-result lazy route is session/tool-call scoped and drops arbitrary path-like extras", () => {
	assert.equal(PIX_TOOL_RESULT_METHOD, "pix/session/tool_result");
	assert.deepEqual(parseDesktopToolResultRequest({
		sessionId: "session-1",
		toolCallId: "tool-1",
		path: "/tmp/pi-bash-not-a-route.log",
		fullOutputPath: "/tmp/pi-ast-grep-not-a-route/output.txt",
	}), {
		sessionId: "session-1",
		toolCallId: "tool-1",
	});
	assert.throws(() => parseDesktopToolResultRequest({ sessionId: "session-1", toolCallId: "" }));
	assert.throws(() => parseDesktopToolResultRequest({ toolCallId: "tool-1" }));
});

test("desktop registry actions are session-scoped and validate resource/project targets", () => {
	assert.equal(PIX_REGISTRY_ACTION_METHOD, "pix/registry/action");
	assert.deepEqual(parseDesktopRegistryActionRequest({ sessionId: "session-1", action: "refresh" }), {
		sessionId: "session-1",
		action: "refresh",
	});
	assert.deepEqual(parseDesktopRegistryActionRequest({ sessionId: "session-1", action: "configure" }), {
		sessionId: "session-1",
		action: "configure",
	});
	assert.deepEqual(parseDesktopRegistryActionRequest({
		sessionId: "session-1",
		action: "update",
		type: "skill",
		name: "pdf",
	}), {
		sessionId: "session-1",
		action: "update",
		type: "skill",
		name: "pdf",
	});
	assert.deepEqual(parseDesktopRegistryActionRequest({
		sessionId: "session-1",
		action: "pull-project",
		scope: "todo",
	}), {
		sessionId: "session-1",
		action: "pull-project",
		scope: "todo",
	});
	assert.throws(() => parseDesktopRegistryActionRequest({ sessionId: "session-1", action: "remove", type: "skill", name: "../bad" }));
	assert.throws(() => parseDesktopRegistryActionRequest({ sessionId: "session-1", action: "pull-project", scope: "skills" }));
});

test("desktop Git assistant accepts bounded review and commit-message diffs", () => {
	assert.equal(PIX_GIT_ASSIST_METHOD, "pix/git/assist");
	assert.deepEqual(parseDesktopGitAssistantRequest({
		sessionId: "session-1",
		kind: "review",
		diff: "diff --git a/a.ts b/a.ts\n+const ready = true;",
	}), {
		sessionId: "session-1",
		kind: "review",
		diff: "diff --git a/a.ts b/a.ts\n+const ready = true;",
	});
	assert.deepEqual(parseDesktopGitAssistantRequest({
		sessionId: "session-1",
		kind: "commit-message",
		diff: "+feature",
	}), {
		sessionId: "session-1",
		kind: "commit-message",
		diff: "+feature",
	});
	assert.throws(() => parseDesktopGitAssistantRequest({ sessionId: "session-1", kind: "review", diff: "" }));
	assert.throws(() => parseDesktopGitAssistantRequest({ sessionId: "session-1", kind: "other", diff: "+x" }));
	assert.throws(() => parseDesktopGitAssistantRequest({ sessionId: "session-1", kind: "review", diff: "x".repeat(200_001) }));
});
