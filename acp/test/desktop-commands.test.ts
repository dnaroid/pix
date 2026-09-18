import assert from "node:assert/strict";
import { test } from "node:test";

import {
	PIX_GIT_ASSIST_METHOD,
	PIX_CLEAR_TODOS_METHOD,
	PIX_DRAFT_CONFIG_METHOD,
	PIX_REGISTRY_ACTION_METHOD,
	PIX_TOOL_RESULT_METHOD,
	parseDesktopDraftConfigRequest,
	parseDesktopGitAssistantRequest,
	parseDesktopRegistryActionRequest,
	parseDesktopToolResultRequest,
} from "../src/acp/desktop-commands.js";

test("desktop draft config is workspace-scoped and does not require a session id", () => {
	assert.equal(PIX_DRAFT_CONFIG_METHOD, "pix/session/draft_config");
	assert.deepEqual(parseDesktopDraftConfigRequest({ cwd: "/workspace", sessionId: "ignored" }), {
		cwd: "/workspace",
	});
	assert.deepEqual(parseDesktopDraftConfigRequest({
		cwd: "/workspace",
		modelRef: "openai-codex/gpt-5.6-sol",
		thinkingLevel: "high",
		refreshModelUsage: true,
	}), {
		cwd: "/workspace",
		modelRef: "openai-codex/gpt-5.6-sol",
		thinkingLevel: "high",
		refreshModelUsage: true,
	});
	assert.throws(() => parseDesktopDraftConfigRequest({ cwd: "" }));
	assert.throws(() => parseDesktopDraftConfigRequest({ cwd: "/workspace", refreshModelUsage: "yes" }));
	assert.throws(() => parseDesktopDraftConfigRequest({}));
});

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

test("desktop todo clear is a private session-scoped command", () => {
	assert.equal(PIX_CLEAR_TODOS_METHOD, "pix/session/clear_todos");
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
		cwd: "/tmp/project",
		kind: "review",
		diff: "diff --git a/a.ts b/a.ts\n+const ready = true;",
	}), {
		cwd: "/tmp/project",
		kind: "review",
		diff: "diff --git a/a.ts b/a.ts\n+const ready = true;",
	});
	assert.deepEqual(parseDesktopGitAssistantRequest({
		cwd: "/tmp/project",
		kind: "commit-message",
		diff: "+feature",
	}), {
		cwd: "/tmp/project",
		kind: "commit-message",
		diff: "+feature",
	});
	assert.throws(() => parseDesktopGitAssistantRequest({ cwd: "", kind: "review", diff: "+x" }));
	assert.throws(() => parseDesktopGitAssistantRequest({ cwd: "/tmp/project", kind: "review", diff: "" }));
	assert.throws(() => parseDesktopGitAssistantRequest({ cwd: "/tmp/project", kind: "other", diff: "+x" }));
	assert.throws(() => parseDesktopGitAssistantRequest({ cwd: "/tmp/project", kind: "review", diff: "x".repeat(200_001) }));
});
