import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { installContextInventoryHost } from "../src/pi/context-inventory-host.js";

test("RPC inventory reports the current session's loaded context paths, not contents", async () => {
	const calls: Array<{ key: string; lines: string[] | undefined; options: unknown[] }> = [];
	class Session {
		paths = ["/parent/AGENTS.md", "/project/AGENTS.override.md", "/parent/AGENTS.md"];
		addendumPaths = ["/project/.pi/AGENTS.md"];
		resourceLoader = {
			getAgentsFiles: () => ({ agentsFiles: this.paths.map((path) => ({ path, content: "secret instructions" })) }),
			getAppendSystemPromptSources: () => this.addendumPaths.map((path) => ({ path })),
		};
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
	assert.deepEqual(JSON.parse(calls.at(-1)!.lines![1]).contextFiles, ["/parent/AGENTS.md", "/project/AGENTS.override.md", "/project/.pi/AGENTS.md"]);
	assert.ok(!calls.at(-1)!.lines![1].includes("secret instructions"));
	// Rebinding without a new UI context is how the SDK retains RPC UI across reload.
	session.paths = ["/changed/AGENTS.md"];
	session.addendumPaths = ["/changed/.pi/AGENTS.md"];
	await session.bindExtensions({});
	assert.deepEqual(JSON.parse(calls.at(-1)!.lines![1]).contextFiles, ["/changed/AGENTS.md", "/changed/.pi/AGENTS.md"]);
	session.paths = [];
	session.addendumPaths = [];
	session.publish();
	assert.deepEqual(JSON.parse(calls.at(-1)!.lines![1]).contextFiles, []);
	const replacement = new Session();
	replacement.paths = ["/replacement/AGENTS.md"];
	replacement.addendumPaths = ["/replacement/.pi/AGENTS.md"];
	await replacement.bindExtensions({ uiContext: session.ui });
	assert.deepEqual(JSON.parse(calls.at(-1)!.lines![1]).contextFiles, ["/replacement/AGENTS.md", "/replacement/.pi/AGENTS.md"]);
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

test("private AGENTS.md augments the live RPC loader without losing ordinary files or addenda", async (t) => {
	const cwd = mkdtempSync(join(tmpdir(), "pix-rpc-private-context-"));
	t.after(() => rmSync(cwd, { recursive: true, force: true }));
	mkdirSync(join(cwd, ".pi"));
	const privateAgentsPath = join(cwd, ".pi", "AGENTS.md");
	writeFileSync(privateAgentsPath, "\uFEFFFirst personal rules");
	const baseFiles = [{ path: join(cwd, "AGENTS.md"), content: "Shared rules" }];
	const emitted = [];
	class Loader {
		getAgentsFiles() { return { agentsFiles: baseFiles }; }
		getAppendSystemPromptSources() { return [{ path: join(cwd, ".pi", "APPEND_SYSTEM.md") }]; }
	}
	class Session {
		resourceLoader = new Loader();
		async bindExtensions(bindings) {
			bindings.uiContext.setWidget("pix.session-state", ["pi-tools-suite:context-inventory", JSON.stringify({ version: 1, reason: "reload", tools: [], skills: [] })]);
		}
	}
	installContextInventoryHost(Session, { privateAgentsPath, DefaultResourceLoader: Loader });
	// Pi's first system prompt is snapshotted inside the session constructor.
	const preSessionLoader = new Loader();
	assert.deepEqual(preSessionLoader.getAgentsFiles().agentsFiles.at(-1), { path: privateAgentsPath, content: "First personal rules" });
	const session = new Session();
	const uiContext = { setWidget: (_key, lines) => emitted.push(JSON.parse(lines[1]).contextFiles) };
	await session.bindExtensions({ uiContext });
	assert.deepEqual(session.resourceLoader.getAgentsFiles().agentsFiles, [
		...baseFiles,
		{ path: privateAgentsPath, content: "First personal rules" },
	]);
	assert.deepEqual(emitted.at(-1), [baseFiles[0].path, privateAgentsPath, join(cwd, ".pi", "APPEND_SYSTEM.md")]);
	writeFileSync(privateAgentsPath, "Updated private rules");
	await session.bindExtensions({ uiContext });
	assert.equal(session.resourceLoader.getAgentsFiles().agentsFiles.at(-1)?.content, "Updated private rules");
	assert.equal(session.resourceLoader.getAppendSystemPromptSources()[0].path, join(cwd, ".pi", "APPEND_SYSTEM.md"));

	rmSync(privateAgentsPath);
	assert.deepEqual(session.resourceLoader.getAgentsFiles().agentsFiles, baseFiles);
});
