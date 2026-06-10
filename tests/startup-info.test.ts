import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { AgentSessionRuntime, LoadExtensionsResult, SourceInfo } from "@earendil-works/pi-coding-agent";

import { createStartupInfoMessage } from "../src/app/cli/startup-info.js";

describe("startup info", () => {
	it("shows the Pix package version instead of the pi sdk version", () => {
		const message = createStartupInfoMessage(runtimeWithExtensions([]));

		assert.match(message, /^Model: unavailable\n\npix v\d+\.\d+\.\d+/u);
		assert.doesNotMatch(message, /pi-sdk/u);
	});

	it("uses compact extension paths instead of repeated source labels", () => {
		const message = createStartupInfoMessage(runtimeWithExtensions([
			extensionAt("/tmp/pix-a/cli/index.ts", { source: "cli" }),
			extensionAt("/tmp/pix-b/cli/index.ts", { source: "cli" }),
			extensionAt("/tmp/pix-c/auto/index.ts", { source: "cli" }),
		]));

		assert.match(message, /\[Extensions\]\n  pix-a\/cli, pix-b\/cli, auto/u);
		assert.doesNotMatch(message, /\[Extensions\]\n  cli, cli/u);
	});

	it("formats model scopes, resources, diagnostics, and extension source labels", () => {
		const runtime = runtimeWithExtensions([
			extensionAt("/workspace/project/.pi/extensions/local/index.ts", { source: "project", scope: "project" }),
			extensionAt("/workspace/project/node_modules/@scope/pkg/extensions/chat/index.ts", {
				source: "npm:@scope/pkg",
				scope: "user",
				baseDir: "/workspace/project/node_modules/@scope/pkg",
			}),
			extensionAt("/workspace/project/.pi/git-ext/extensions/agent.ts", {
				source: "git:https://github.com/acme/ext.git",
				scope: "user",
				baseDir: "/workspace/project/.pi/git-ext",
			}),
		], {
			model: { provider: "anthropic", id: "claude" },
			thinkingLevel: "medium",
			scopedModels: [{ model: { id: "openai/gpt-4" }, thinkingLevel: "off" }, { model: { id: "zai/glm" }, thinkingLevel: "high" }],
			promptTemplates: [{ name: "daily", description: "local", sourceInfo: sourceInfo("/workspace/project/prompts/daily.md") }],
			agentsFiles: [{ path: "/workspace/project/AGENTS.md" }, { path: "/tmp/outside/AGENTS.md" }],
			skills: [{ name: "lint", description: "lint code", sourceInfo: sourceInfo("/workspace/project/skills/lint/SKILL.md") }],
			prompts: [{ name: "daily" }, { name: "review" }],
			themes: [{ name: "Solar" }, { sourcePath: "/workspace/project/themes/dark.ts" }],
			diagnostics: {
				skills: [{ type: "warning", message: "bad skill", path: "skills/bad" }],
				prompts: [{ type: "error", message: "bad prompt" }],
				themes: [{ type: "info", message: "theme note", path: "theme.json" }],
			},
			extensionErrors: [{ path: "/workspace/project/extensions/broken.ts", error: "boom" }],
		});

		const message = createStartupInfoMessage(runtime);

		assert.match(message, /^Model scope: openai\/gpt-4, zai\/glm:high/u);
		assert.match(message, /\[Context\]\n  AGENTS\.md, AGENTS\.md/u);
		assert.match(message, /\[Skills\]\n  lint/u);
		assert.match(message, /\[Prompts\]\n  daily, review/u);
		assert.match(message, /\[Extensions\]\n  local, @scope\/pkg:chat, acme\/ext:agent\.ts/u);
		assert.match(message, /\[Themes\]\n  Solar, themes\/dark\.ts/u);
		assert.match(message, /skills: \[warning\] bad skill \(skills\/bad\)/u);
		assert.match(message, /prompts: \[error\] bad prompt/u);
		assert.match(message, /themes: \[info\] theme note \(theme\.json\)/u);
		assert.match(message, /extensions: extensions\/broken\.ts — boom/u);
	});

	it("falls back to sourceInfo paths and unknown labels when theme names are missing", () => {
		const message = createStartupInfoMessage(runtimeWithExtensions([], {
			themes: [{ sourceInfo: sourceInfo("/workspace/project/themes/dark.ts") }, {} as never],
		}));

		assert.match(message, /\[Themes\]\n  themes\/dark\.ts, unknown/u);
	});

});

function runtimeWithExtensions(extensions: LoadExtensionsResult["extensions"], overrides: RuntimeOverrides = {}): AgentSessionRuntime {
	return {
		cwd: "/workspace/project",
		session: {
			model: overrides.model ?? undefined,
			thinkingLevel: overrides.thinkingLevel ?? "off",
			scopedModels: overrides.scopedModels ?? [],
			messages: overrides.messages,
			promptTemplates: overrides.promptTemplates ?? [],
			resourceLoader: {
				getAgentsFiles: () => ({ agentsFiles: overrides.agentsFiles ?? [] }),
				getSkills: () => ({ skills: overrides.skills ?? [], diagnostics: overrides.diagnostics?.skills ?? [] }),
				getPrompts: () => ({ prompts: overrides.prompts ?? [], diagnostics: overrides.diagnostics?.prompts ?? [] }),
				getExtensions: () => ({ extensions, errors: overrides.extensionErrors ?? [], runtime: {} as LoadExtensionsResult["runtime"] }),
				getThemes: () => ({ themes: overrides.themes ?? [], diagnostics: overrides.diagnostics?.themes ?? [] }),
			},
		},
	} as unknown as AgentSessionRuntime;
}

type RuntimeOverrides = {
	model?: unknown;
	thinkingLevel?: string;
	scopedModels?: unknown[];
	messages?: unknown;
	promptTemplates?: unknown[];
	agentsFiles?: Array<{ path: string }>;
	skills?: unknown[];
	prompts?: unknown[];
	themes?: unknown[];
	diagnostics?: { skills?: unknown[]; prompts?: unknown[]; themes?: unknown[] };
	extensionErrors?: Array<{ path: string; error: string }>;
};

function extensionAt(path: string, sourceInfoOverrides: Partial<SourceInfo> = {}): LoadExtensionsResult["extensions"][number] {
	return {
		path,
		resolvedPath: path,
		sourceInfo: {
			path,
			source: path,
			scope: "temporary",
			origin: "top-level",
			...sourceInfoOverrides,
		},
		handlers: new Map(),
		tools: new Map(),
		messageRenderers: new Map(),
		commands: new Map(),
		flags: new Map(),
		shortcuts: new Map(),
	};
}

function sourceInfo(path: string): SourceInfo {
	return { path, source: path, scope: "project", origin: "top-level" };
}
