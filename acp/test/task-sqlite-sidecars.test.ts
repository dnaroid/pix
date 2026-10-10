import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, mkdtemp, writeFile, open, unlink, link, symlink, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { assertTaskFile, safeTaskFileNlink } from "../src/registry/task-database.js";

test("registry distinguishes SQLite's unlinked WAL/SHM from genuine hard links", async t => {
	const fixtures = resolve(".pi/artifacts/task-sqlite-sidecar-tests");
	await mkdir(fixtures, { recursive: true });
	const folder = await mkdtemp(join(fixtures, "run-"));
	t.after(() => rm(folder, { recursive: true, force: true }));
	assert.equal(safeTaskFileNlink(0, true), true);
	assert.equal(safeTaskFileNlink(0), false, "the main database is never allowed to be unlinked");
	assert.equal(safeTaskFileNlink(1), true);
	assert.equal(safeTaskFileNlink(2, true), false);

	for (const suffix of ["-wal", "-shm", "-journal"]) {
		const filename = join(folder, `tasks.sqlite${suffix}`);
		await writeFile(filename, "SQLite sidecar");
		assert.equal(await assertTaskFile(filename, true, true), true);
		const handle = await open(filename, "r");
		try {
			await unlink(filename);
			const state = await handle.stat();
			assert.equal(state.nlink, 0, "POSIX-unlinked inode remains observable via an open handle");
			assert.equal(safeTaskFileNlink(state.nlink, true), true);
		} finally { await handle.close(); }
		assert.equal(await assertTaskFile(filename, true, true), false);

		await writeFile(filename, "SQLite sidecar");
		const alias = join(folder, `alias${suffix}`);
		await link(filename, alias);
		await assert.rejects(assertTaskFile(filename, true, true), /regular single-link file/);
		await unlink(alias);
		await unlink(filename);

		await symlink("missing-target", filename);
		await assert.rejects(assertTaskFile(filename, true, true), /regular single-link file/);
		await unlink(filename);
	}

	const canonicalDb = join(folder, "tasks.sqlite");
	await writeFile(canonicalDb, "placeholder");
	const alias = join(folder, "main-db-alias");
	await link(canonicalDb, alias);
	await assert.rejects(assertTaskFile(canonicalDb), /regular single-link file/);
});
