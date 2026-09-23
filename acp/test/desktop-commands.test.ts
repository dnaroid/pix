import assert from "node:assert/strict";
import { test } from "node:test";

import {
	PIX_GIT_ASSIST_METHOD,
	PIX_CLEAR_TODOS_METHOD,
	PIX_DRAFT_CONFIG_METHOD,
	PIX_MODEL_ROUTING_STATUS_METHOD,
	PIX_MODEL_ROUTE_METHOD,
	PIX_REGISTRY_ACTION_METHOD,
	PIX_TOOL_RESULT_METHOD,
	parseDesktopDraftConfigRequest,
	parseDesktopModelRoutingStatusRequest,
	parseDesktopModelRouteRequest,
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

test("desktop model routing is workspace-scoped and validates first-prompt metadata", () => {
	assert.equal(PIX_MODEL_ROUTING_STATUS_METHOD, "pix/model/routing_status");
	assert.deepEqual(parseDesktopModelRoutingStatusRequest({ cwd: "/workspace" }), { cwd: "/workspace" });
	assert.throws(() => parseDesktopModelRoutingStatusRequest({ cwd: "" }));
	assert.equal(PIX_MODEL_ROUTE_METHOD, "pix/model/route");
	assert.deepEqual(parseDesktopModelRouteRequest({
		cwd: "/workspace",
		prompt: "Implement the subsystem",
		attachmentCount: 2,
	}), {
		cwd: "/workspace",
		prompt: "Implement the subsystem",
		attachmentCount: 2,
	});
	assert.deepEqual(parseDesktopModelRouteRequest({
		cwd: "/workspace",
		prompt: "",
		attachmentCount: 1.9,
	}), {
		cwd: "/workspace",
		prompt: "",
		attachmentCount: 1,
	});
	assert.throws(() => parseDesktopModelRouteRequest({ cwd: "", prompt: "x", attachmentCount: 0 }));
	assert.throws(() => parseDesktopModelRouteRequest({ cwd: "/workspace", prompt: "x", attachmentCount: -1 }));
	assert.throws(() => parseDesktopModelRouteRequest({ cwd: "/workspace", prompt: "x", attachmentCount: "1" }));
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

test("desktop registry actions are workspace-scoped and validate resource/project targets", () => {
	assert.equal(PIX_REGISTRY_ACTION_METHOD, "pix/registry/action");
	assert.deepEqual(parseDesktopRegistryActionRequest({ cwd: "/workspace", action: "refresh", sessionId: "ignored" }), {
		cwd: "/workspace",
		action: "refresh",
	});
	assert.deepEqual(parseDesktopRegistryActionRequest({ cwd: "/workspace", action: "configure" }), {
		cwd: "/workspace",
		action: "configure",
	});
	assert.deepEqual(parseDesktopRegistryActionRequest({
		cwd: "/workspace",
		action: "update",
		type: "skill",
		name: "pdf",
	}), {
		cwd: "/workspace",
		action: "update",
		type: "skill",
		name: "pdf",
	});
	assert.deepEqual(parseDesktopRegistryActionRequest({
		cwd: "/workspace",
		action: "pull-project",
		scope: "todo",
	}), {
		cwd: "/workspace",
		action: "pull-project",
		scope: "todo",
	});
	for (const action of ["push-project", "pull-project"] as const) {
		assert.deepEqual(parseDesktopRegistryActionRequest({ cwd: "/workspace", action, scope: "workspace" }), {
			cwd: "/workspace",
			action,
			scope: "workspace",
		});
	}
	assert.throws(() => parseDesktopRegistryActionRequest({ action: "refresh" }));
	assert.throws(() => parseDesktopRegistryActionRequest({ cwd: "/workspace", action: "remove", type: "skill", name: "../bad" }));
	assert.throws(() => parseDesktopRegistryActionRequest({ cwd: "/workspace", action: "pull-project", scope: "skills" }));
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
