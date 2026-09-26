import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { THEMES } from "../src/theme.js";
import { renderWorkspaceToolModal } from "../src/app/workspace-tools/workspace-tool-renderer.js";

describe("renderWorkspaceToolModal", () => {
	it("centers a nearly full viewport modal and exposes row targets", () => {
		const rows = renderWorkspaceToolModal({
			title: "Tasks",
			subtitle: ".pi/tasks.jsonc",
			lines: [
				{ text: "Feature 1", action: "task:1" },
				{ text: "Run task", action: "run-selected", control: "button" },
			],
		}, 100, 2, 30, THEMES.dark);

		assert.ok(rows.length >= 20);
		assert.equal(rows[0]?.column, 3);
		assert.match(rows[0]?.text ?? "", /Tasks/);
		assert.equal(rows.find((row) => row.target?.action === "task:1")?.target?.kind, "workspace-tool");
		const button = rows.find((row) => row.target?.action === "run-selected");
		assert.match(button?.text ?? "", /\[ Run task \]/u);
		assert.ok((button?.target?.endColumn ?? 0) - (button?.target?.startColumn ?? 0) < 20);
		const close = rows.find((row) => row.target?.action === "close")?.target;
		assert.ok(close?.startColumn !== undefined && close.endColumn !== undefined);
		assert.ok((close.endColumn - close.startColumn) < 6, "only the close affordance should dismiss the modal");
		assert.equal(rows.at(-1)?.text.startsWith("╰"), true);
	});
});
