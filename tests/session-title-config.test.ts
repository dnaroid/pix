import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, it } from "node:test";

const testHome = mkdtempSync(join(tmpdir(), "pix-session-title-home-"));
const testConfigDir = join(testHome, ".config", "pi");
const testConfigPath = join(testConfigDir, "pix.jsonc");
const dedicatedConfigPath = join(testConfigDir, "session-title.jsonc");
process.env.HOME = testHome;
delete process.env.PI_CONFIG_DIR;
delete process.env.PI_OFFLINE;
delete process.env.PI_SESSION_TITLE_ENABLED;
delete process.env.PI_SESSION_TITLE_MODEL;
delete process.env.PI_SESSION_TITLE_TERMINAL_TITLE;
delete process.env.PI_SESSION_TITLE_TERMINAL_PREFIX;
delete process.env.PI_SESSION_TITLE_NOTIFY;
delete process.env.PI_SESSION_TITLE_DEBUG;

const { loadSessionTitleConfig } = await import("../extensions/session-title/config.js");

describe("session-title config", () => {
	beforeEach(() => {
		rmSync(testConfigDir, { recursive: true, force: true });
		mkdirSync(testConfigDir, { recursive: true });
	});

	it("loads sessionTitle from pix config", () => {
		writeFileSync(testConfigPath, `{
			// renderer settings may live next to extension settings
			"promptEnhancer": { "modelRef": "zai/enhancer" },
			"sessionTitle": {
				"modelRef": "zai/title-model",
				"maxTitleChars": 42,
				"terminalTitle": false
			}
		}`);

		const config = loadSessionTitleConfig(join(testHome, "workspace"));

		assert.equal(config.model, "zai/title-model");
		assert.equal(config.maxTitleChars, 42);
		assert.equal(config.terminalTitle, false);
	});

	it("lets dedicated session-title config override pix config", () => {
		writeFileSync(testConfigPath, `{
			"sessionTitle": { "modelRef": "zai/title-from-pix" }
		}`);
		writeFileSync(dedicatedConfigPath, `{
			"model": "zai/title-from-dedicated"
		}`);

		const config = loadSessionTitleConfig(join(testHome, "workspace"));

		assert.equal(config.model, "zai/title-from-dedicated");
	});
});
