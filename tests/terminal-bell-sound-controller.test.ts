import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
	readTerminalBellSoundEnabled,
	TerminalBellSoundController,
	writeTerminalBellSoundEnabled,
} from "../src/app/terminal/terminal-bell-sound-controller.js";
import { APP_ICONS } from "../src/app/icons.js";

describe("TerminalBellSoundController", () => {
	it("defaults to enabled when the shared config is missing", () => {
		const configPath = join(tempDir(), "pi-tools-suite.jsonc");

		assert.equal(readTerminalBellSoundEnabled(configPath), true);
	});

	it("writes terminalBell.sound into the shared pi-tools-suite config", () => {
		const configPath = join(tempDir(), "pi-tools-suite.jsonc");

		writeTerminalBellSoundEnabled(false, configPath);

		assert.equal(readTerminalBellSoundEnabled(configPath), false);
		assert.match(readFileSync(configPath, "utf-8"), /"terminalBell"/u);
		assert.match(readFileSync(configPath, "utf-8"), /"sound": false/u);
	});

	it("toggles the status icon and persisted notification flag", () => {
		const configPath = join(tempDir(), "pi-tools-suite.jsonc");
		const controller = new TerminalBellSoundController(configPath);

		assert.equal(controller.statusWidgetText(), APP_ICONS.volumeHigh);
		assert.equal(controller.toggle(), false);
		assert.equal(controller.statusWidgetText(), APP_ICONS.volumeOff);
		assert.equal(readTerminalBellSoundEnabled(configPath), false);
	});
});

function tempDir(): string {
	return mkdtempSync(join(tmpdir(), "pix-terminal-bell-"));
}
