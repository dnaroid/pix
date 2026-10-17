import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { createPixSessionsSource } from "../src/app/usage-stats/pix-sessions.js";
import type { UsageBucket } from "../src/app/usage-stats/types.js";

const jsonl = (...rows: unknown[]) => rows.map((row) => `${JSON.stringify(row)}\n`).join("");
const sum = (buckets: readonly UsageBucket[], key: "totalTokens" | "calls" | "input" | "cacheRead" | "output") =>
	buckets.reduce((total, bucket) => total + (bucket.values[key] ?? 0), 0);

async function put(path: string, content: string): Promise<void> {
	await mkdir(join(path, ".."), { recursive: true });
	await writeFile(path, content);
}

describe("usage-stats local sources", () => {
	let dir: string;
	beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "pix-usage-src-")); });
	afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

	describe("pix-sessions", () => {
		it("uses shared session accounting, session names and counts forked copies once", async () => {
			const agentDir = join(dir, "agent");
			const sessionDir = join(agentDir, "sessions", "--work-c--");
			const call = {
				type: "message", id: "e2", parentId: "e1", timestamp: "2026-10-01T09:00:02.000Z",
				message: { role: "assistant", provider: "openai-codex", model: "gpt-5.5", timestamp: Date.parse("2026-10-01T09:00:02.000Z"), usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { total: 0.01 } } },
			};
			await put(join(sessionDir, "2026-10-01_a.jsonl"), jsonl(
				{ type: "session", id: "sa", cwd: "/work/c", timestamp: "2026-10-01T09:00:00.000Z" },
				{ type: "message", id: "e1", parentId: null, timestamp: "2026-10-01T09:00:01.000Z", message: { role: "user", content: "hi" } },
				call,
				{ type: "message", id: "e3", parentId: "e2", timestamp: "2026-10-01T09:00:03.000Z", message: { role: "toolResult", usage: { totalTokens: 4, cost: { total: 0 } } } },
				{ type: "session_info", id: "e4", parentId: "e3", timestamp: "2026-10-01T09:00:04.000Z", name: "Usage work" },
			));
			// Forked session copies ancestor entries with their ids and timestamps.
			await put(join(sessionDir, "2026-10-01_b.jsonl"), jsonl(
				{ type: "session", id: "sb", cwd: "/work/c", timestamp: "2026-10-01T09:30:00.000Z", parentSession: "sa" },
				call,
			));

			const result = await createPixSessionsSource({ agentDir }).collect();
			const { snapshot } = result;
			assert.equal(result.duplicateRecords, 1);
			assert.equal(sum(snapshot.buckets, "totalTokens"), 19);
			const attributed = snapshot.buckets.find((bucket) => bucket.provider === "openai-codex");
			assert.equal(attributed?.model, "gpt-5.5");
			assert.equal(attributed?.sessionId, "sa");
			assert.equal(attributed?.values.cost, 0.01);
			const unattributed = snapshot.buckets.find((bucket) => bucket.provider === null);
			assert.equal(unattributed?.model, null);
			assert.equal(unattributed?.values.totalTokens, 4);
			const session = snapshot.sessions?.find((entry) => entry.sessionId === "sa");
			assert.equal(session?.name, "Usage work");
			assert.equal(session?.userTurns, 1);
			assert.equal(session?.projectCwd, "/work/c");
			assert.equal(session?.sessionFile, join(sessionDir, "2026-10-01_a.jsonl"));
			assert.notEqual(session?.sessionFile, snapshot.sessions?.find((entry) => entry.sessionId === "sb")?.sessionFile);
		});

		it("collects every project and attributes usage by the session header cwd", async () => {
			const agentDir = join(dir, "agent");
			const usage = (id: string, totalTokens: number) => ({
				type: "message", id, parentId: null, timestamp: "2026-10-02T10:00:00.000Z",
				message: { role: "assistant", provider: "anthropic", model: "m", usage: { input: totalTokens, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens, cost: { total: 0 } } },
			});
			await put(join(agentDir, "sessions", "--work-a--", "a.jsonl"), jsonl({ type: "session", id: "pa", cwd: "/work/a" }, usage("x1", 7)));
			await put(join(agentDir, "sessions", "--work-b--", "b.jsonl"), jsonl({ type: "session", id: "pb", cwd: "/work/b" }, usage("x2", 11)));

			const { snapshot } = await createPixSessionsSource({ agentDir }).collect();
			const byProject = (cwd: string) => sum(snapshot.buckets.filter((bucket) => bucket.projectCwd === cwd), "totalTokens");
			assert.equal(byProject("/work/a"), 7);
			assert.equal(byProject("/work/b"), 11);
			assert.deepEqual(snapshot.sessions?.map((session) => session.projectCwd).sort(), ["/work/a", "/work/b"]);
		});

		it("emits recent files first on a cold collection, then the full history once", async () => {
			const agentDir = join(dir, "agent");
			const sessionDir = join(agentDir, "sessions", "--work-c--");
			const row = (id: string, at: string, tokens: number) => ({
				type: "message", id, parentId: null, timestamp: at,
				message: { role: "assistant", provider: "zai", model: "glm", timestamp: Date.parse(at), usage: { input: tokens, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: tokens, cost: { total: 0 } } },
			});
			const recentPath = join(sessionDir, "recent.jsonl");
			const oldPath = join(sessionDir, "old.jsonl");
			await put(recentPath, jsonl({ type: "session", id: "r", cwd: "/work/c" }, row("r1", "2026-10-16T09:00:00.000Z", 5)));
			await put(oldPath, jsonl({ type: "session", id: "o", cwd: "/work/c" }, row("o1", "2026-01-02T09:00:00.000Z", 7)));
			const old = new Date(Date.now() - 60 * 86_400_000);
			await utimes(oldPath, old, old);

			const source = createPixSessionsSource({ agentDir, partialWindowMs: 7 * 86_400_000 });
			const partials: import("../src/app/usage-stats/types.js").UsageSourceSnapshot[] = [];
			const result = await source.collect(undefined, (snapshot) => partials.push(snapshot));
			assert.equal(partials.length, 1);
			assert.equal(partials[0]!.status, "loading");
			assert.equal(partials[0]!.coverage, null);
			assert.equal(sum(partials[0]!.buckets, "totalTokens"), 5);
			assert.equal(sum(result.snapshot.buckets, "totalTokens"), 12);

			await source.collect(undefined, (snapshot) => partials.push(snapshot));
			assert.equal(partials.length, 1, "warm collections skip the partial pass");
			source.clear();
			await source.collect(undefined, (snapshot) => partials.push(snapshot));
			assert.equal(partials.length, 2, "clearing the cache makes the next collection cold again");
		});

		it("reports a missing sessions directory as unavailable", async () => {
			const result = await createPixSessionsSource({ agentDir: join(dir, "none") }).collect();
			assert.equal(result.snapshot.status, "unavailable");
			assert.deepEqual(result.snapshot.buckets, []);
		});
	});
});
