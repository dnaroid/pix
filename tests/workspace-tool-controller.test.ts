import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { WorkspaceToolController, type WorkspaceToolSurface } from "../src/app/workspace-tools/workspace-tool-controller.js";

describe("WorkspaceToolController", () => {
	it("toggles one modal surface at a time and lets a surface consume Escape", async () => {
		let renders = 0;
		let taskOpened = 0;
		let taskClosed = 0;
		let editing = true;
		const tasks: WorkspaceToolSurface = {
			id: "tasks",
			open: () => { taskOpened += 1; },
			close: () => { taskClosed += 1; },
			snapshot: () => ({ title: "Tasks", lines: [] }),
			handleInput: (data) => {
				if (data !== "\x1b" || !editing) return false;
				editing = false;
				return true;
			},
		};
		const controller = new WorkspaceToolController({ render: () => { renders += 1; } });
		controller.register(tasks);

		controller.toggle("tasks");
		assert.equal(controller.activeTool, "tasks");
		assert.equal(taskOpened, 1);

		assert.equal(controller.handleTerminalInput("\x1b").consume, true);
		assert.equal(controller.activeTool, "tasks", "surface Escape wins while editing");

		assert.equal(controller.handleTerminalInput("\x1b").consume, true);
		assert.equal(controller.activeTool, undefined);
		assert.equal(taskClosed, 1);
		assert.ok(renders >= 2);
	});

	it("switches tools without starting hidden work", () => {
		const events: string[] = [];
		const surface = (id: "tasks" | "idx"): WorkspaceToolSurface => ({
			id,
			open: () => { events.push(`open:${id}`); },
			close: () => { events.push(`close:${id}`); },
			snapshot: () => ({ title: id, lines: [] }),
		});
		const controller = new WorkspaceToolController({ render: () => {} });
		controller.register(surface("tasks"));
		controller.register(surface("idx"));

		controller.toggle("tasks");
		controller.toggle("idx");
		assert.deepEqual(events, ["open:tasks", "close:tasks", "open:idx"]);
	});

	it("keeps a foreground operation visible when the active surface refuses close", () => {
		const controller = new WorkspaceToolController({ render: () => {} });
		controller.register({
			id: "idx",
			open: () => {},
			canClose: () => false,
			snapshot: () => ({ title: "IDX", lines: [] }),
		});
		controller.toggle("idx");
		controller.close();
		controller.toggle("tasks");
		assert.equal(controller.activeTool, "idx");
	});

	it("scrolls long surfaces without asking the surface to own viewport state", () => {
		const controller = new WorkspaceToolController({ render: () => {} });
		controller.register({
			id: "settings",
			open: () => {},
			snapshot: () => ({
				title: "Settings",
				lines: Array.from({ length: 20 }, (_, index) => ({ text: `row-${index}` })),
			}),
		});
		controller.toggle("settings");
		controller.scroll(4);
		assert.equal(controller.snapshot()?.lines[0]?.text, "row-4");
		controller.handleTerminalInput("\x1b[5~");
		assert.equal(controller.snapshot()?.lines[0]?.text, "row-0");
	});
});
