import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { loadTuiTabSnapshot } from "../src/acp/tui-tabs.js";

async function snapshotPath(agentDir: string, cwd: string): Promise<string> {
	const key = createHash("sha256").update(resolve(cwd)).digest("hex").slice(0, 24);
	const path = join(agentDir, "pix", "tabs", `${key}.json`);
	await mkdir(dirname(path), { recursive: true });
	return path;
}

test("loads ordered, deduplicated session paths from the TUI snapshot", async () => {
	const agentDir = await mkdtemp(join(tmpdir(), "pix-tabs-"));
	const cwd = "/tmp/project/../project";
	const sessionDir = await mkdtemp(join(tmpdir(), "pix-tab-sessions-"));
	const firstSession = join(sessionDir, "a.jsonl");
	const secondSession = join(sessionDir, "b.jsonl");
	await writeFile(firstSession, "", "utf8");
	await writeFile(secondSession, "", "utf8");
	const path = await snapshotPath(agentDir, cwd);
	await writeFile(path, JSON.stringify({
		version: 4,
		activePath: secondSession,
		tabs: [
			{ path: firstSession },
			{ path: secondSession },
			{ path: firstSession },
			{ path: join(sessionDir, "deleted.jsonl") },
			{ path: 42 },
		],
	}), "utf8");

	assert.deepEqual(await loadTuiTabSnapshot(cwd, agentDir), {
		sessionPaths: [firstSession, secondSession],
		activeSessionPath: secondSession,
	});
});

test("missing or malformed TUI snapshots are non-fatal", async () => {
	const agentDir = await mkdtemp(join(tmpdir(), "pix-tabs-"));
	assert.deepEqual(await loadTuiTabSnapshot("/tmp/missing", agentDir), { sessionPaths: [] });

	const path = await snapshotPath(agentDir, "/tmp/malformed");
	await writeFile(path, "not json", "utf8");
	assert.deepEqual(await loadTuiTabSnapshot("/tmp/malformed", agentDir), { sessionPaths: [] });

	const futurePath = await snapshotPath(agentDir, "/tmp/future-version");
	await writeFile(futurePath, JSON.stringify({ version: 99, tabs: [{ path: "/tmp/session.jsonl" }] }), "utf8");
	assert.deepEqual(await loadTuiTabSnapshot("/tmp/future-version", agentDir), { sessionPaths: [] });
});
