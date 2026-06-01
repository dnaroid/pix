import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatResumeCommand } from "../src/app/cli.js";

describe("CLI helpers", () => {
	it("formats a pix resume command", () => {
		assert.equal(
			formatResumeCommand({ cwd: "/repo", sessionPath: "/repo/.pi/sessions/session.jsonl" }),
			"pix --cwd /repo --session /repo/.pi/sessions/session.jsonl",
		);
	});

	it("quotes resume command paths for the shell", () => {
		assert.equal(
			formatResumeCommand({ cwd: "/repo with spaces", sessionPath: "/repo/it isn't easy.jsonl" }),
			"pix --cwd '/repo with spaces' --session '/repo/it isn'\\''t easy.jsonl'",
		);
	});
});
