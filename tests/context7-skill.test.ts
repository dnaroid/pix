import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

const scriptPath = new URL("../skills/context7/scripts/context7.sh", import.meta.url);

describe("context7 skill credentials", () => {
	it("requires an explicit API key without shipping a fallback secret", async () => {
		const source = await readFile(scriptPath, "utf8");
		assert.doesNotMatch(source, /ctx7sk-/u);

		const env = { ...process.env };
		delete env.CONTEXT7_API_KEY;
		const result = spawnSync("bash", [scriptPath.pathname, "resolve", "React"], {
			env,
			encoding: "utf8",
		});

		assert.notEqual(result.status, 0);
		assert.match(result.stderr, /requires CONTEXT7_API_KEY/u);
	});
});
