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
	it("logs shell lifecycle and exit metadata without command text, input or output", async () => {
		const diagnostics: Array<{ level: string; event: string; details: Record<string, unknown>; project?: string }> = [];
		const result: InteractiveShellCommandResult = { exitCode: 7, signal: null, error: "token=private-error-text" };
		const controller = new AppShellController({
			cwd: "/tmp/project",
			isRunning: () => true,
			activeScopeKey: () => "tab-a",
			addEntry: () => {},
			touchEntry: () => {},
			setStatus: () => {},
			setSessionActivity: () => {},
			restoreSessionStatus: () => {},
			render: () => {},
			scheduleRender: () => {},
		}, {
			runChatShellCommand: () => ({
				done: Promise.resolve(result),
				writeInput: () => true, interrupt: () => true, kill: () => true, endInput: () => {},
			}),
			log: (level, event, details, scope) => {
				diagnostics.push({ level, event, details: details ?? {}, project: scope?.project ?? undefined });
			},
		});
		assert.equal(await controller.run("echo private-command-text"), result);
		assert.deepEqual(diagnostics.map(({ level, event }) => [level, event]), [
			["debug", "shell:started"], ["error", "shell:settled"],
		]);
		assert.equal(diagnostics[1]?.details.exitCode, 7);
		assert.equal(diagnostics[1]?.project, "/tmp/project");
		assert.doesNotMatch(JSON.stringify(diagnostics), /private-command-text|private-error-text/);
	});

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
