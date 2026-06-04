import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { getPixLogPath, PixFileLogger, trimLogFile } from "../src/app/logger.js";

describe("pix file logger", () => {
	it("writes to ~/.config/pi/pix.log by default", () => {
		assert.equal(getPixLogPath("/home/test"), "/home/test/.config/pi/pix.log");
	});

	it("appends log lines and trims to the configured line limit", async () => {
		const dir = await mkdtemp(join(tmpdir(), "pix-logger-"));
		try {
			const logPath = join(dir, "pix.log");
			const logger = new PixFileLogger({ logPath, maxLines: 3 });

			await logger.info("first event", { index: 1 });
			await logger.warn("second", { index: 2 });
			await logger.error("third", { index: 3 });
			await logger.debug("fourth", { index: 4 });
			await logger.flush();

			const lines = (await readFile(logPath, "utf8")).trimEnd().split("\n");
			assert.equal(lines.length, 3);
			assert.doesNotMatch(lines.join("\n"), /first_event/u);
			assert.match(lines[0] ?? "", /WARN second \{"index":2\}/u);
			assert.match(lines[2] ?? "", /DEBUG fourth \{"index":4\}/u);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("can trim an existing log file", async () => {
		const dir = await mkdtemp(join(tmpdir(), "pix-logger-"));
		try {
			const logPath = join(dir, "pix.log");
			const logger = new PixFileLogger({ logPath, maxLines: 10 });
			for (let index = 0; index < 5; index += 1) {
				await logger.info("line", { index });
			}
			await trimLogFile(logPath, 2);

			const lines = (await readFile(logPath, "utf8")).trimEnd().split("\n");
			assert.equal(lines.length, 2);
			assert.match(lines[0] ?? "", /\{"index":3\}/u);
			assert.match(lines[1] ?? "", /\{"index":4\}/u);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});
