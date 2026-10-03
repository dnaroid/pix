import assert from "node:assert/strict";
import { test } from "node:test";
import { installContextInventoryHost } from "../src/pi/context-inventory-host.js";

test("RPC inventory reports the current session's loaded context paths, not contents", async () => {
	const calls: Array<{ key: string; lines: string[] | undefined; options: unknown[] }> = [];
	class Session {
		paths = ["/parent/AGENTS.md", "/project/AGENTS.override.md", "/parent/AGENTS.md"];
		resourceLoader = { getAgentsFiles: () => ({ agentsFiles: this.paths.map((path) => ({ path, content: "secret instructions" })) }) };
		ui: any;
		async bindExtensions(bindings: any) {
			if (bindings.uiContext) this.ui = bindings.uiContext;
			this.publish();
		}
		publish() {
			this.ui.setWidget("pix.session-state", ["pi-tools-suite:context-inventory", JSON.stringify({ version: 1, reason: "reload", tools: [], skills: [] })]);
		}
	}
	installContextInventoryHost(Session);
	const session = new Session();
	await session.bindExtensions({ uiContext: { setWidget: (key: string, lines: string[] | undefined, ...options: unknown[]) => calls.push({ key, lines, options }) } });
	assert.deepEqual(JSON.parse(calls.at(-1)!.lines![1]).contextFiles, ["/parent/AGENTS.md", "/project/AGENTS.override.md"]);
	assert.ok(!calls.at(-1)!.lines![1].includes("secret instructions"));
	// Rebinding without a new UI context is how the SDK retains RPC UI across reload.
	session.paths = ["/changed/AGENTS.md"];
	await session.bindExtensions({});
	assert.deepEqual(JSON.parse(calls.at(-1)!.lines![1]).contextFiles, ["/changed/AGENTS.md"]);
	session.paths = [];
	session.publish();
	assert.deepEqual(JSON.parse(calls.at(-1)!.lines![1]).contextFiles, []);
	const replacement = new Session();
	replacement.paths = ["/replacement/AGENTS.md"];
	await replacement.bindExtensions({ uiContext: session.ui });
	assert.deepEqual(JSON.parse(calls.at(-1)!.lines![1]).contextFiles, ["/replacement/AGENTS.md"]);
	// Unrelated widgets, widget removal, and malformed/unsupported events pass through.
	for (const lines of [undefined, ["other-channel", "{}"], ["pi-tools-suite:context-inventory", "bad json"], ["pi-tools-suite:context-inventory", '{"version":2}']]) {
		session.ui.setWidget("pix.session-state", lines, { placement: "aboveEditor" });
		assert.strictEqual(calls.at(-1)!.lines, lines);
		assert.deepEqual(calls.at(-1)!.options, [{ placement: "aboveEditor" }]);
	}
	session.ui.setWidget("other-widget", ["pi-tools-suite:context-inventory", "{}"]);
	assert.deepEqual(calls.at(-1)!.lines, ["pi-tools-suite:context-inventory", "{}"]);
});

test("loader failures leave the optional inventory unavailable", async () => {
	class Session {
		resourceLoader = { getAgentsFiles: () => { throw new Error("unavailable"); } };
		async bindExtensions(bindings: any) {
			bindings.uiContext.setWidget("pix.session-state", ["pi-tools-suite:context-inventory", '{"version":1,"tools":[],"skills":[]}']);
		}
	}
	installContextInventoryHost(Session);
	await new Session().bindExtensions({ uiContext: { setWidget: (_key: string, lines: string[]) => assert.equal(JSON.parse(lines[1]).contextFiles, undefined) } });
});
