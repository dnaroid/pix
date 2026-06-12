import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { detectFileLinks, hyperlink } from "../src/app/screen/file-links.js";

describe("file link detection", () => {
	it("detects relative, absolute, file URL, and markdown-anchor file references", () => {
		const cwd = mkdtempSync(join(tmpdir(), "pix-file-links-"));
		const relative = join(cwd, "src", "app.ts");
		const absolute = join(cwd, "absolute.txt");
		const anchored = join(cwd, "anchored.md");
		mkdirSync(join(cwd, "src"));
		writeFileSync(relative, "export {};\n", { flag: "wx" });
		writeFileSync(absolute, "absolute\n", { flag: "wx" });
		writeFileSync(anchored, "# title\n", { flag: "wx" });

		const text = `See ./src/app.ts:12:3, ${absolute}:4+2 and ./anchored.md#L7C2.`;
		const links = detectFileLinks(text, cwd);

		assert.equal(links.length, 3);
		assert.deepEqual(links.map((link) => ({ filePath: link.filePath, line: link.line, column: link.column })), [
			{ filePath: relative, line: 12, column: 3 },
			{ filePath: absolute, line: 4, column: undefined },
			{ filePath: anchored, line: 7, column: 2 },
		]);
		assert.equal(links[0]?.url.endsWith("/src/app.ts:12:3"), true);
	});

	it("detects web URLs alongside file links", () => {
		const cwd = mkdtempSync(join(tmpdir(), "pix-file-links-"));
		mkdirSync(join(cwd, "docs"));
		const readme = join(cwd, "docs", "readme.md");
		writeFileSync(readme, "# readme\n", { flag: "wx" });

		const links = detectFileLinks("See https://example.com/docs. Also open ./docs/readme.md", cwd);

		assert.equal(links.length, 2);
		assert.equal(links[0]?.url, "https://example.com/docs");
		assert.equal(links[1]?.filePath, readme);
	});

	it("ignores non-files, invalid URLs, missing cwd, and overlapping shorter links", () => {
		const cwd = mkdtempSync(join(tmpdir(), "pix-file-links-"));
		const nested = join(cwd, "nested", "file.ts");
		mkdirSync(join(cwd, "nested"));
		writeFileSync(nested, "nested\n", { flag: "wx" });

		assert.deepEqual(detectFileLinks("no slash here", cwd), []);
		assert.deepEqual(detectFileLinks("./nested/file.ts", undefined), []);
		assert.deepEqual(detectFileLinks("file://%zz ./missing.ts", cwd), []);

		const links = detectFileLinks("./nested/file.ts ./nested/file.ts:2", cwd);
		assert.equal(links.length, 2);
		assert.equal(links[1]?.line, 2);
	});

	it("formats OSC 8 hyperlinks", () => {
		assert.equal(hyperlink("src/app.ts", "file:///tmp/src/app.ts"), "\x1b]8;;file:///tmp/src/app.ts\x07src/app.ts\x1b]8;;\x07");
	});
});
