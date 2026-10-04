import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, describe, it } from "node:test";
import { DEFAULT_HEADS_UP_CONFIG, DEFAULT_HEADS_UP_MODEL } from "../src/bundled-extensions/heads-up/config.js";
import { loadHeadsUpSettings } from "../src/bundled-extensions/heads-up/settings.js";

const home = mkdtempSync(join(tmpdir(), "pix-heads-up-home-"));
const cwd = mkdtempSync(join(tmpdir(), "pix-heads-up-project-"));
const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;
const originalProfile = process.env.PIX_CONFIG_PROFILE;
const originalOffline = process.env.PI_OFFLINE;

function desktopConfigPath(): string {
	return join(home, ".config", "pi", "pix-desktop.jsonc");
}
function projectConfigPath(): string {
	return join(cwd, ".pi", "pix-desktop.jsonc");
}
function writeDesktopConfig(content: string): void {
	mkdirSync(join(home, ".config", "pi"), { recursive: true });
	writeFileSync(desktopConfigPath(), content);
}
function writeProjectConfig(content: string): void {
	mkdirSync(join(cwd, ".pi"), { recursive: true });
	writeFileSync(projectConfigPath(), content);
}

describe("Desktop heads-up settings", () => {
	beforeEach(() => {
		rmSync(join(home, ".config"), { recursive: true, force: true });
		rmSync(join(cwd, ".pi"), { recursive: true, force: true });
		process.env.HOME = home;
		process.env.USERPROFILE = home;
		process.env.PIX_CONFIG_PROFILE = "desktop";
		delete process.env.PI_OFFLINE;
	});
	after(() => {
		rmSync(home, { recursive: true, force: true });
		rmSync(cwd, { recursive: true, force: true });
		if (originalHome === undefined) delete process.env.HOME; else process.env.HOME = originalHome;
		if (originalUserProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = originalUserProfile;
		if (originalProfile === undefined) delete process.env.PIX_CONFIG_PROFILE; else process.env.PIX_CONFIG_PROFILE = originalProfile;
		if (originalOffline === undefined) delete process.env.PI_OFFLINE; else process.env.PI_OFFLINE = originalOffline;
	});

	it("uses only the Desktop profile, not standalone or TUI config", async () => {
		writeDesktopConfig('{"headsUp":{"enabled":true,"model":"zai/desktop"}}');
		writeFileSync(join(home, ".config", "pi", "heads-up.jsonc"), '{"enabled":true,"model":"zai/standalone"}');
		writeFileSync(join(home, ".config", "pi", "pix.jsonc"), '{"headsUp":{"enabled":true,"model":"zai/tui"}}');

		const settings = await loadHeadsUpSettings(cwd, false);
		assert.equal(settings.enabled, true);
		assert.equal(settings.model, "zai/desktop");
	});

	it("applies a trusted project Desktop override and keeps untrusted projects isolated", async () => {
		writeDesktopConfig('{"headsUp":{"enabled":true,"model":"zai/global","minTurns":9}}');
		writeProjectConfig('{"headsUp":{"enabled":false,"model":"zai/project","minTurns":2}}');

		const trusted = await loadHeadsUpSettings(cwd, true);
		assert.equal(trusted.enabled, false);
		assert.equal(trusted.model, "zai/project");
		assert.equal(trusted.config.minTurns, 2);

		const untrusted = await loadHeadsUpSettings(cwd, false);
		assert.equal(untrusted.enabled, true);
		assert.equal(untrusted.model, "zai/global");
		assert.equal(untrusted.config.minTurns, 9);
	});

	it("falls back safely for malformed and oversized files", async () => {
		writeDesktopConfig('{"headsUp":');
		let settings = await loadHeadsUpSettings(cwd, false);
		assert.equal(settings.enabled, false);
		assert.equal(settings.model, DEFAULT_HEADS_UP_MODEL);
		assert.deepEqual(settings.config, DEFAULT_HEADS_UP_CONFIG);

		writeDesktopConfig(`{"headsUp":{"enabled":true,"model":"zai/too-large"},"padding":"${"x".repeat(1_048_577)}"}`);
		settings = await loadHeadsUpSettings(cwd, false);
		assert.equal(settings.enabled, false);
		assert.equal(settings.model, DEFAULT_HEADS_UP_MODEL);
		assert.deepEqual(settings.config, DEFAULT_HEADS_UP_CONFIG);
	});

	it("accepts a larger Desktop profile without inheriting standalone observer limits", async () => {
		writeDesktopConfig(`{"headsUp":{"enabled":true,"minTurns":7},"padding":"${"x".repeat(20_000)}"}`);
		assert.equal((await loadHeadsUpSettings(cwd, false)).config.minTurns, 7);
	});

	it("accepts JSONC comments/trailing commas and honors offline as a hard stop", async () => {
		writeDesktopConfig('{ // comment\n "headsUp": { "enabled": true, "minTurns": 8, }, }');
		assert.equal((await loadHeadsUpSettings(cwd, false)).config.minTurns, 8);
		process.env.PI_OFFLINE = "YES";
		assert.equal((await loadHeadsUpSettings(cwd, false)).enabled, false);
	});

	it("TUI keeps standalone settings and never reads Desktop defaults", async () => {
		delete process.env.PIX_CONFIG_PROFILE;
		writeDesktopConfig('{"headsUp":{"enabled":true,"model":"provider/desktop"}}');
		const agent = join(home, ".pi", "agent");
		mkdirSync(agent, { recursive: true });
		writeFileSync(join(agent, "heads-up.jsonc"), '{"enabled":false,"model":"provider/terminal"}');
		const previousDir = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = agent;
		try {
			const settings = await loadHeadsUpSettings(cwd, false);
			assert.equal(settings.model, "provider/terminal");
			assert.equal(settings.enabled, false);
		} finally {
			if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previousDir;
		}
	});
});
