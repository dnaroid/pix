import { describe, expect, mock, test } from "bun:test";

import { createTypeboxMock } from "./support/typebox-mock.js";

mock.module("typebox", () => createTypeboxMock());

class FakePi {
	tools = new Map<string, any>();
	sessionName: string | undefined;

	registerTool(tool: any) { this.tools.set(tool.name, tool); }
	setSessionName(name: string) { this.sessionName = name; }
	getSessionName() { return this.sessionName; }
}

describe("session_name tool", () => {
	test("registers and sets the current session name", async () => {
		const { default: register } = await import("../src/session-name/index.js");
		const pi = new FakePi();

		register(pi as any);
		const tool = pi.tools.get("session_name");

		expect(tool).toBeTruthy();

		const result = await tool.execute("call", { name: "Short Story" });

		expect(pi.getSessionName()).toBe("Short Story");
		expect(result).toMatchObject({
			content: [{ type: "text", text: "Session name set: Short Story" }],
			details: { changed: true, sessionName: "Short Story" },
		});
	});

	test("returns the current session name when no name is provided", async () => {
		const { default: register } = await import("../src/session-name/index.js");
		const pi = new FakePi();
		pi.setSessionName("Existing Session");

		register(pi as any);
		const tool = pi.tools.get("session_name");

		const result = await tool.execute("call", {});

		expect(result).toMatchObject({
			content: [{ type: "text", text: "Current session name: Existing Session" }],
			details: { changed: false, sessionName: "Existing Session" },
		});
	});
});
