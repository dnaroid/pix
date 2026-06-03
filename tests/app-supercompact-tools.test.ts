import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { PiUiExtendApp } from "../src/app/app.js";
import type { Entry } from "../src/app/types.js";

type TestApp = {
	entries: Entry[];
	superCompactTools: boolean;
	toggleSuperCompactTools(): void;
};

function createApp(): TestApp {
	return new PiUiExtendApp({ cwd: process.cwd(), themeName: "dark", noSession: true }) as unknown as TestApp;
}

function toolEntry(toolName: string, expanded: boolean): Extract<Entry, { kind: "tool" }> {
	return {
		id: `tool-${toolName}`,
		kind: "tool",
		toolCallId: `call-${toolName}`,
		toolName,
		argsText: "",
		output: "body",
		expanded,
		isError: false,
		status: "done",
	};
}

describe("PiUiExtendApp super-compact tool toggle", () => {
	it("restores default-expanded tools when leaving super-compact mode", () => {
		const app = createApp();
		const mutationTool = toolEntry("apply_patch", true);
		const regularTool = toolEntry("read", true);
		app.entries.push(mutationTool, regularTool);

		app.toggleSuperCompactTools();

		assert.equal(app.superCompactTools, true);
		assert.equal(mutationTool.expanded, false);
		assert.equal(regularTool.expanded, false);

		app.toggleSuperCompactTools();

		assert.equal(app.superCompactTools, false);
		assert.equal(mutationTool.expanded, true);
		assert.equal(regularTool.expanded, false);
	});
});
