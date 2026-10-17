import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	isSubagentSessionPath,
	readSessionHeaderId,
	readSubagentSessionState,
	removeParentSubagentSessions,
	resolveSubagentSession,
	snapshotSessionFile,
} from "../src/acp/subagent-sessions.js";

async function fixture() {
	const cwd = await realpath(await mkdtemp(join(tmpdir(), "pix-subagent-sessions-")));
	const runDir = join(cwd, ".pi", "subagents", "2026-10-17T00-00-00-run");
	const agentDir = join(runDir, "agent-1");
	const sessionsDir = join(agentDir, "sessions");
	await mkdir(sessionsDir, { recursive: true });
	const sessionFile = join(sessionsDir, "child.jsonl");
	await writeFile(sessionFile, `${JSON.stringify({ type: "session", id: "child-id", cwd })}\n{"type":"message"}\n`);
	await writeFile(join(agentDir, "session_file"), sessionFile);
	return { cwd, runDir, agentDir, sessionsDir, sessionFile };
}

test("resolves a sub-agent session and reports display-only terminal state", async () => {
	const f = await fixture();
	try {
		const resolved = await resolveSubagentSession(f.cwd, f.runDir, "agent-1");
		assert.equal(resolved.sessionFile, f.sessionFile);
		assert.equal(resolved.agentDir, f.agentDir);
		// Relative run names resolve against the project sub-agent root.
		assert.equal((await resolveSubagentSession(f.cwd, "2026-10-17T00-00-00-run", "agent-1")).sessionFile, f.sessionFile);

		assert.equal((await readSubagentSessionState(resolved)).terminal, false);
		await writeFile(join(f.agentDir, "exit_code"), "0");
		const done = await readSubagentSessionState(resolved);
		assert.equal(done.terminal, true);
		await writeFile(join(f.agentDir, "retry_pending"), "1");
		assert.equal((await readSubagentSessionState(resolved)).terminal, false);

		const before = done.revision;
		await writeFile(f.sessionFile, `${await readFile(f.sessionFile, "utf8")}{"type":"message","n":2}\n`);
		assert.notEqual((await readSubagentSessionState(resolved)).revision, before);
		assert.equal(await readSessionHeaderId(f.sessionFile), "child-id");
	} finally {
		await rm(f.cwd, { recursive: true, force: true });
	}
});

test("rejects unsafe ids, escaping run dirs and symlinked session links", async () => {
	const f = await fixture();
	const outside = await realpath(await mkdtemp(join(tmpdir(), "pix-subagent-outside-")));
	try {
		await assert.rejects(resolveSubagentSession(f.cwd, f.runDir, "../agent-1"), /unsafe/);
		await assert.rejects(resolveSubagentSession(f.cwd, outside, "agent-1"), /outside/);
		await assert.rejects(resolveSubagentSession(f.cwd, join(f.cwd, ".pi", "subagents"), "agent-1"), /outside|not found/);

		const foreign = join(outside, "foreign.jsonl");
		await writeFile(foreign, "{}\n");
		await writeFile(join(f.agentDir, "session_file"), foreign);
		await assert.rejects(resolveSubagentSession(f.cwd, f.runDir, "agent-1"), /outside the agent sessions/);

		const escaping = join(f.sessionsDir, "escape.jsonl");
		await symlink(foreign, escaping);
		await writeFile(join(f.agentDir, "session_file"), escaping);
		await assert.rejects(resolveSubagentSession(f.cwd, f.runDir, "agent-1"), /outside the agent sessions/);

		const linkedAgent = join(f.runDir, "linked");
		await symlink(f.agentDir, linkedAgent);
		await writeFile(join(f.agentDir, "session_file"), f.sessionFile);
		await assert.rejects(resolveSubagentSession(f.cwd, f.runDir, "linked"), /symlink/);
	} finally {
		await rm(f.cwd, { recursive: true, force: true });
		await rm(outside, { recursive: true, force: true });
	}
});

test("snapshot drops a partial trailing line and never touches the source", async () => {
	const f = await fixture();
	try {
		const partial = `${await readFile(f.sessionFile, "utf8")}{"type":"partial-tail`;
		await writeFile(f.sessionFile, partial);
		const target = join(f.cwd, "snapshot.jsonl");
		await snapshotSessionFile(f.sessionFile, target);
		const copied = await readFile(target, "utf8");
		assert.ok(copied.endsWith("\n"));
		assert.ok(copied.includes(`{"type":"message"}`));
		assert.ok(!copied.includes("partial-tail"));
		assert.equal(await readFile(f.sessionFile, "utf8"), partial);
		await assert.rejects(snapshotSessionFile(f.sessionFile, target));
	} finally {
		await rm(f.cwd, { recursive: true, force: true });
	}
});

test("resolves a child in its parent-scoped .pi/subagents/<parentSessionId>/ dir (decision 0072)", async () => {
	const f = await fixture();
	try {
		const parentDir = join(f.cwd, ".pi", "subagents", "0199f0c2-1111-7222-8333-944445555666");
		await mkdir(parentDir, { recursive: true });
		const child = join(parentDir, "child.jsonl");
		await writeFile(child, `${JSON.stringify({ type: "session", id: "scoped-id", cwd: f.cwd })}\n`);
		await rm(f.sessionsDir, { recursive: true, force: true });
		await writeFile(join(f.agentDir, "session_file"), child);
		assert.equal((await resolveSubagentSession(f.cwd, f.runDir, "agent-1")).sessionFile, child);

		// A non-UUID directory (e.g. a legacy run dir) is not a parent-scoped root.
		const runFile = join(f.runDir, "child.jsonl");
		await writeFile(runFile, "{}\n");
		await writeFile(join(f.agentDir, "session_file"), runFile);
		await assert.rejects(resolveSubagentSession(f.cwd, f.runDir, "agent-1"), /outside the agent sessions/);

		// Nested deeper than the parent dir is rejected too.
		const deeper = join(parentDir, "nested");
		await mkdir(deeper);
		await writeFile(join(deeper, "child.jsonl"), "{}\n");
		await writeFile(join(f.agentDir, "session_file"), join(deeper, "child.jsonl"));
		await assert.rejects(resolveSubagentSession(f.cwd, f.runDir, "agent-1"), /outside the agent sessions/);

		// A parent-scoped dir of another project is rejected.
		const other = await realpath(await mkdtemp(join(tmpdir(), "pix-subagent-other-")));
		try {
			const foreignDir = join(other, ".pi", "subagents", "0199f0c2-1111-7222-8333-944445555666");
			await mkdir(foreignDir, { recursive: true });
			await writeFile(join(foreignDir, "child.jsonl"), "{}\n");
			await writeFile(join(f.agentDir, "session_file"), join(foreignDir, "child.jsonl"));
			await assert.rejects(resolveSubagentSession(f.cwd, f.runDir, "agent-1"), /outside the agent sessions/);
		} finally {
			await rm(other, { recursive: true, force: true });
		}

		// No recorded link and no legacy sessions dir.
		await rm(join(f.agentDir, "session_file"));
		await assert.rejects(resolveSubagentSession(f.cwd, f.runDir, "agent-1"), /no persisted session/);
	} finally {
		await rm(f.cwd, { recursive: true, force: true });
	}
});

test("recognizes sub-agent session paths only inside the sub-agent tree", () => {
	assert.equal(isSubagentSessionPath("/p/.pi/subagents/0199f0c2-1111-7222-8333-944445555666/child.jsonl"), true);
	assert.equal(isSubagentSessionPath("/p/.pi/subagents/0199f0c2-1111-7222-8333-944445555666/notes.md"), false);
	assert.equal(isSubagentSessionPath("/p/.pi/subagents/2026-10-17T00-00-00-run/child.jsonl"), false);
	assert.equal(isSubagentSessionPath("/home/u/.pi/agent/sessions/--p--/subagents/parent/child.jsonl"), false);
	assert.equal(isSubagentSessionPath("/p/.pi/subagents/run/agent/sessions/x.jsonl"), true);
	assert.equal(isSubagentSessionPath("/p/.pi/subagents/run/agent/result.md"), false);
	assert.equal(isSubagentSessionPath("/home/u/.pi/agent/sessions/--p--/x.jsonl"), false);
});

test("removes a deleted parent's .pi/subagents/<id>/ dir but never owned or unsafe dirs (decision 0072)", async () => {
	const f = await fixture();
	const outside = await realpath(await mkdtemp(join(tmpdir(), "pix-subagent-outside-")));
	try {
		const root = join(f.cwd, ".pi", "subagents");
		const id = "0199f0c2-1111-7222-8333-944445555666";
		await mkdir(join(root, id), { recursive: true });
		await writeFile(join(root, id, "child.jsonl"), "{}\n");
		assert.equal(await removeParentSubagentSessions(f.cwd, id), "removed");
		assert.equal(await removeParentSubagentSessions(f.cwd, id), "absent");
		// Legacy run dirs and path tricks are never targets.
		assert.equal(await removeParentSubagentSessions(f.cwd, "2026-10-17T00-00-00-run"), "skipped-unsafe");
		assert.equal(await removeParentSubagentSessions(f.cwd, `../${id}`), "skipped-unsafe");
		await readFile(join(f.agentDir, "session_file"), "utf8");

		const owned = "0199f0c2-2222-7222-8333-944445555666";
		await mkdir(join(root, owned, "owned", "launch"), { recursive: true });
		assert.equal(await removeParentSubagentSessions(f.cwd, owned), "skipped-owned");
		assert.ok((await readFile(join(f.agentDir, "session_file"), "utf8")).length > 0);

		const linked = "0199f0c2-3333-7222-8333-944445555666";
		await writeFile(join(outside, "keep.jsonl"), "{}\n");
		await symlink(outside, join(root, linked));
		assert.equal(await removeParentSubagentSessions(f.cwd, linked), "skipped-unsafe");
		assert.equal(await readFile(join(outside, "keep.jsonl"), "utf8"), "{}\n");
	} finally {
		await rm(f.cwd, { recursive: true, force: true });
		await rm(outside, { recursive: true, force: true });
	}
});
