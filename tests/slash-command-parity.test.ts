import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { BUILTIN_SLASH_COMMANDS as PI_SLASH_COMMANDS } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/slash-commands.js";
import {
	BUILTIN_SLASH_COMMANDS as ACP_SLASH_COMMANDS,
	PIX_RENDERER_COMMAND_NAMES,
	PIX_UNSUPPORTED_COMMAND_NAMES,
} from "../acp/src/acp/slash-commands.js";
import { DESKTOP_SLASH_COMMANDS } from "../desktop/src/lib/slash-commands.js";
import type { CommandControllerHost } from "../src/app/commands/command-controller.js";
import { createSlashCommands, type CommandRegistryActions } from "../src/app/commands/command-registry.js";

const EXPECTED_PI_COMMANDS = [
	"settings",
	"model",
	"tree",
	"thinking",
	"scoped-models",
	"export",
	"import",
	"share",
	"copy",
	"name",
	"session",
	"changelog",
	"hotkeys",
	"fork",
	"clone",
	"trust",
	"login",
	"logout",
	"new",
	"compact",
	"resume",
	"reload",
	"quit",
] as const;

/** Features intentionally postponed rather than silently missing. */
const EXPLICITLY_DEFERRED_COMMANDS = new Set<string>();

/** Commands deliberately unsupported in Pix Desktop by product decision. */
const INTENTIONALLY_UNSUPPORTED_COMMANDS = new Set(["trust", "login", "logout"]);

/** TUI slash commands whose workflow already exists as first-class Desktop UI rather than a Desktop slash command. */
const TUI_COMMANDS_WITH_DESKTOP_UI_EQUIVALENTS = new Set(["code-review", "commit-message"]);

function desktopCommandNames(): string[] {
	return DESKTOP_SLASH_COMMANDS.flatMap((command) => {
		const aliases = command._meta?.["pix.aliases"];
		return [
			command.name,
			...(Array.isArray(aliases) ? aliases.filter((alias): alias is string => typeof alias === "string") : []),
		];
	});
}

describe("slash command parity", () => {
	it("pins the Pi 0.85.1 built-in catalog so upgrades cannot silently drift", () => {
		assert.deepEqual(PI_SLASH_COMMANDS.map((command) => command.name), [...EXPECTED_PI_COMMANDS]);
	});

	it("pins the Pix Desktop intentionally unsupported command decision", () => {
		assert.deepEqual([...PIX_UNSUPPORTED_COMMAND_NAMES].sort(), [...INTENTIONALLY_UNSUPPORTED_COMMANDS].sort());
	});

	it("accounts for every Pi and Pix TUI command as implemented, deferred, or intentionally unsupported", () => {
		const tuiCommands = createSlashCommands(
			{} as CommandRegistryActions,
			{ stop: async () => undefined } as CommandControllerHost,
		);
		const implemented = new Set([
			...ACP_SLASH_COMMANDS.map((command) => command.name),
			...desktopCommandNames(),
		]);
		const expected = new Set([
			...PI_SLASH_COMMANDS.map((command) => command.name),
			...tuiCommands.map((command) => command.name),
		]);
		const unaccounted = [...expected].filter(
			(name) => !implemented.has(name)
				&& !TUI_COMMANDS_WITH_DESKTOP_UI_EQUIVALENTS.has(name)
				&& !EXPLICITLY_DEFERRED_COMMANDS.has(name)
				&& !INTENTIONALLY_UNSUPPORTED_COMMANDS.has(name),
		);
		assert.deepEqual(unaccounted, []);
	});

	it("never marks a renderer command unless Desktop owns it, it is deferred, or intentionally unsupported", () => {
		const desktop = new Set(desktopCommandNames());
		const dangling = [...PIX_RENDERER_COMMAND_NAMES].filter(
			(name) => !desktop.has(name)
				&& !EXPLICITLY_DEFERRED_COMMANDS.has(name)
				&& !INTENTIONALLY_UNSUPPORTED_COMMANDS.has(name),
		);
		assert.deepEqual(dangling, []);
	});
});
