import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { AgentSessionRuntime, LoadExtensionsResult, SourceInfo } from "@earendil-works/pi-coding-agent";

import { createStartupInfoMessage } from "../src/app/startup-info.js";

describe("startup info", () => {
	it("uses compact extension paths instead of repeated source labels", () => {
		const message = createStartupInfoMessage(runtimeWithExtensions([
			extensionAt("/tmp/pix-a/cli/index.ts", { source: "cli" }),
			extensionAt("/tmp/pix-b/cli/index.ts", { source: "cli" }),
			extensionAt("/tmp/pix-c/auto/index.ts", { source: "cli" }),
		]));

		assert.match(message, /\[Extensions\]\n  pix-a\/cli, pix-b\/cli, auto/u);
		assert.doesNotMatch(message, /\[Extensions\]\n  cli, cli/u);
	});
});

function runtimeWithExtensions(extensions: LoadExtensionsResult["extensions"]): AgentSessionRuntime {
	return {
		cwd: "/workspace/project",
		session: {
			model: undefined,
			thinkingLevel: "off",
			scopedModels: [],
			promptTemplates: [],
			resourceLoader: {
				getAgentsFiles: () => ({ agentsFiles: [] }),
				getSkills: () => ({ skills: [], diagnostics: [] }),
				getPrompts: () => ({ prompts: [], diagnostics: [] }),
				getExtensions: () => ({ extensions, errors: [], runtime: {} as LoadExtensionsResult["runtime"] }),
				getThemes: () => ({ themes: [], diagnostics: [] }),
			},
		},
	} as unknown as AgentSessionRuntime;
}

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
