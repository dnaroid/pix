import assert from "node:assert/strict";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import { formatResumeCommand, parseArgs, usage } from "../src/app/cli/cli.js";

describe("CLI helpers", () => {
	it("parses cwd, session, model, theme, and no-session flags", () => {
		assert.deepEqual(parseArgs(["--cwd", ".", "--theme", "light", "--model", "zai/glm:high", "--no-session"]), {
			cwd: process.cwd(),
			themeName: "light",
			modelRef: "zai/glm:high",
			noSession: true,
		});

		assert.deepEqual(parseArgs(["--session", ".pi/sessions/run.jsonl"]), {
			cwd: process.cwd(),
			themeName: "dark",
			noSession: false,
			sessionPath: resolve(".pi/sessions/run.jsonl"),
		});
	});

	it("rejects invalid CLI argument combinations and missing values", () => {
		assert.throws(() => parseArgs(["--cwd"]), /Missing value for --cwd/u);
		assert.throws(() => parseArgs(["--model"]), /Missing value for --model/u);
		assert.throws(() => parseArgs(["--session"]), /Missing value for --session/u);
		assert.throws(() => parseArgs(["--theme"]), /Missing value for --theme/u);
		assert.throws(() => parseArgs(["--theme", "blue"]), /Unknown theme: blue/u);
		assert.throws(() => parseArgs(["--no-session", "--session", "run.jsonl"]), /--session cannot be used with --no-session/u);
		assert.throws(() => parseArgs(["--unknown"]), /Unknown argument: --unknown/u);
	});

	it("prints usage and exits for help flags", () => {
		const originalLog = console.log;
		const originalExit = process.exit;
		const logged: string[] = [];
		try {
			console.log = (message?: unknown) => {
				logged.push(String(message));
			};
			process.exit = ((code?: number) => {
				throw new Error(`exit:${code ?? 0}`);
			}) as never;

			assert.throws(() => parseArgs(["-h"]), /exit:0/u);
			assert.equal(logged[0], usage());
		} finally {
			console.log = originalLog;
			process.exit = originalExit;
		}
	});

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
