import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

test("Desktop extension startup does not eagerly import the SDK", () => {
	const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
		import assert from "node:assert/strict";
		import { registerHooks } from "node:module";
		registerHooks({ resolve(specifier, context, next) {
			if (specifier === "@earendil-works/pi-coding-agent") throw new Error("eager SDK import: " + context.parentURL);
			return next(specifier, context);
		} });
		const { default: title } = await import("./src/bundled-extensions/session-title/index.ts");
		await import("./src/bundled-extensions/heads-up/index.ts");
		await import("./src/bundled-extensions/quota-wait/index.ts");
		await import("./src/bundled-extensions/question/index.ts");
		await import("./src/bundled-extensions/html-sandbox/index.ts");
		const { default: undo } = await import("./src/bundled-extensions/workspace-undo/index.ts");
		undo({ on() {}, registerCommand() {} });
		const { loadHeadsUpSettings } = await import("./src/bundled-extensions/heads-up/settings.ts");
		const handlers = new Map();
		title({ on: (event, handler) => handlers.set(event, handler), getSessionName: () => undefined });
		const ctx = { cwd: process.cwd(), hasUI: false, sessionManager: { getSessionId: () => "startup" } };
		await handlers.get("session_start")({ reason: "startup" }, ctx);
		await handlers.get("session_shutdown")({}, ctx);
		await loadHeadsUpSettings(process.cwd(), false);
		// Prove that the hook really rejects runtime imports, not erased type imports.
		await assert.rejects(import("@earendil-works/pi-coding-agent"), /eager SDK import/);
	`], {
		cwd: fileURLToPath(new URL("../", import.meta.url)),
		env: { ...process.env, PIX_CONFIG_PROFILE: "desktop", PIX_ACP_WORKSPACE_UNDO_BRIDGE: "1" },
		encoding: "utf8",
		timeout: 30_000,
	});
	assert.ifError(result.error);
	assert.equal(result.status, 0, result.stderr || result.stdout);
});
