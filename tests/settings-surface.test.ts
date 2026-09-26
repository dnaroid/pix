import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { defaultPixConfig } from "../src/config.js";
import { SettingsWorkspaceToolSurface } from "../src/app/workspace-tools/settings-surface.js";

describe("SettingsWorkspaceToolSurface", () => {
	it("presents mouse-oriented TUI Pix settings rather than Desktop preferences", async () => {
		const config = defaultPixConfig();
		config.defaultModel = { modelRef: "openai/test-model", fallbackModels: [], thinking: "high" };
		const surface = new SettingsWorkspaceToolSurface({
			cwd: "/workspace",
			config: () => config,
			onConfigChanged: () => {},
			render: () => {},
		});
		const text = surface.snapshot().lines.map((line) => line.text).join("\n");
		assert.match(text, /Default model · openai\/test-model/u);
		assert.match(text, /Default thinking · high/u);
		assert.match(text, /pi-tools-suite/u);
		assert.doesNotMatch(text, /pix-desktop\.jsonc/u);
		assert.equal(surface.snapshot().lines.some((line) => line.action === "setting-model" && line.control === "button"), true);

		await surface.activate("setting-model");
		assert.match(surface.snapshot().title, /Default model/u);
		assert.equal(surface.snapshot().lines.some((line) => line.action === "edit-save" && line.control === "button"), true);
	});
});
