import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { AppShellController } from "../src/app/commands/shell-controller.js";
import type {
	ChatShellCommandHandlers,
	InteractiveShellCommandResult,
	RunningChatShellCommand,
} from "../src/app/commands/shell-command.js";
import type { Entry } from "../src/app/types.js";

describe("AppShellController scope ownership", () => {
	it("keeps late output off the active tab after the originating scope changes", async () => {
		let activeScope = "tab-a";
		let handlers: ChatShellCommandHandlers | undefined;
		let resolveDone!: (result: InteractiveShellCommandResult) => void;
		const done = new Promise<InteractiveShellCommandResult>((resolve) => { resolveDone = resolve; });
		const command: RunningChatShellCommand = {
			done,
			writeInput: () => true,
			interrupt: () => true,
			kill: () => true,
			endInput: () => {},
		};
		let entry: Extract<Entry, { kind: "shell" }> | undefined;
		let touches = 0;
		let restores = 0;
		let renders = 0;
		let scheduledRenders = 0;
		const controller = new AppShellController({
			cwd: "/tmp/project",
			isRunning: () => true,
			activeScopeKey: () => activeScope,
			addEntry: (next) => {
				if (next.kind === "shell") entry = next;
			},
			touchEntry: () => { touches += 1; },
			setStatus: () => {},
			setSessionActivity: () => {},
			restoreSessionStatus: () => { restores += 1; },
			render: () => { renders += 1; },
			scheduleRender: () => { scheduledRenders += 1; },
		}, {
			runChatShellCommand: (_command, _cwd, nextHandlers) => {
				handlers = nextHandlers;
				return command;
			},
		});

		const running = controller.run("long command");
		assert.equal(controller.isRunning(), true);
		activeScope = "tab-b";
		assert.equal(controller.isRunning(), false);
		assert.equal(controller.sendInput("wrong tab"), false);
		assert.equal(controller.interrupt(), false);
		handlers?.onOutput?.("late output", "stdout");
		const result = { exitCode: 0, signal: null };
		handlers?.onSettled?.(result);
		resolveDone(result);
		await running;

		assert.equal(entry?.output, "late output");
		assert.equal(entry?.status, "done");
		assert.equal(touches, 0);
		assert.equal(restores, 0);
		assert.equal(renders, 1);
		assert.equal(scheduledRenders, 0);
	});
});
