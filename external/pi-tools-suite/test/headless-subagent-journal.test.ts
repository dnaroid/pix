import { afterEach, expect, test } from "bun:test";
import { appendFileSync, closeSync, ftruncateSync, mkdirSync, mkdtempSync, openSync, rmSync } from "node:fs";
import path from "node:path";
import { createHeadlessSessionManager, headlessJournalFile, headlessScopeId } from "../src/headless/subagent-journal.js";
import { getRecord, hydrateFromManager, resetSubagentStoreForTest, updateRecord } from "../src/async-subagents/core/store.js";
import { runKey } from "../src/async-subagents/core/paths.js";

const roots: string[] = [];
function root() {
	const artifacts = path.resolve(import.meta.dir, "../../../.pi/artifacts");
	mkdirSync(artifacts, { recursive: true });
	const value = mkdtempSync(path.join(artifacts, "subagent-journal-test-")); roots.push(value); return value;
}
afterEach(() => { resetSubagentStoreForTest(); for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true }); });

test("headless scopes are stable for a project/key and isolated across projects and keys", () => {
	expect(headlessScopeId("/a", "key")).toBe(headlessScopeId("/a", "key"));
	expect(headlessScopeId("/a", "key")).not.toBe(headlessScopeId("/b", "key"));
	expect(headlessScopeId("/a", "key")).not.toBe(headlessScopeId("/a", "other"));
});

test("headless journal survives a fresh store, folds nulls and tolerates a torn trailing line", () => {
	const cwd = root(), manager = createHeadlessSessionManager(cwd, "host");
	const runDir = runKey(cwd, manager.getSessionId(), "batch");
	updateRecord(runDir, "agent", { status: "running", pid: 123 }, manager);
	updateRecord(runDir, "agent", { status: "done", pid: null, exitCode: 0 });
	appendFileSync(headlessJournalFile(cwd, "host"), '{"type":"custom"');
	resetSubagentStoreForTest();
	hydrateFromManager(createHeadlessSessionManager(cwd, "host"));
	expect(getRecord(runDir, "agent")).toMatchObject({ status: "done", exitCode: 0 });
	expect(getRecord(runDir, "agent")?.pid).toBeUndefined();
	expect(createHeadlessSessionManager(cwd).getEntries).toBeUndefined();
});

test("oversized journal fails visibly instead of pretending the scope is empty", () => {
	const cwd = root(), file = headlessJournalFile(cwd, "host");
	mkdirSync(path.dirname(file), { recursive: true });
	const fd = openSync(file, "w");
	try { ftruncateSync(fd, 32 * 1024 * 1024 + 1); } finally { closeSync(fd); }
	expect(() => hydrateFromManager(createHeadlessSessionManager(cwd, "host"))).toThrow("32 MiB read limit");
});
