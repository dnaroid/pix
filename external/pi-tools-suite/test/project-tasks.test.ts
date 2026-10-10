import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile, link, unlink, lstat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import registerProjectTasks from "../src/project-tasks/index.js";
import { runProjectTasks, parseProjectTasksParams } from "../src/project-tasks/engine.js";
import { attachTaskFile } from "../src/project-tasks/attachments.js";
import { TASK_COMMAND_USAGE, parseTaskCommand } from "../src/project-tasks/commands.js";
import { safeSqliteSidecarNlink, transaction, withTaskDatabase } from "../src/project-tasks/storage.js";
import { MODULES } from "../src/index.js";
import type { ProjectTask } from "../src/project-tasks/schema.js";

const scratch = fileURLToPath(new URL("../../../.pi/artifacts/project-tasks-sqlite-tests/", import.meta.url));
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const task = (id = "A"): ProjectTask => ({
  id, title: `Task ${id}`, description: "A description", type: "feature",
  status: "todo", priority: "medium", sessionId: "session-1", links: ["specs/project.md"],
  createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
});
const dbPath = (root: string) => path.join(root, ".pi", "tasks.sqlite");
async function fixture(initial: ProjectTask[] = []): Promise<string> {
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(path.join(scratch, "test-"));
  roots.push(root);
  if (initial.length) {
    const folder = path.join(root, ".pi");
    await withTaskDatabase(folder, "create", db => transaction(db!, () => {
      for (const [position, value] of initial.entries()) {
        db!.prepare("INSERT INTO tasks(id,payload,position) VALUES(?,?,?)").run(value.id, JSON.stringify(value), position);
      }
    }));
  }
  return root;
}
async function rows(root: string): Promise<unknown> {
  return withTaskDatabase(path.join(root, ".pi"), "read", db => db?.prepare("SELECT id,payload,revision,position FROM tasks ORDER BY position,id").all() ?? []);
}

describe("project_tasks SQLite-only storage", () => {
  test("accepts an already-unlinked SQLite WAL/SHM inode but still rejects actual hard-linked sidecars", async () => {
    expect(safeSqliteSidecarNlink(0)).toBe(true);
    expect(safeSqliteSidecarNlink(1)).toBe(true);
    expect(safeSqliteSidecarNlink(2)).toBe(false);
    const root = await fixture([task("linked")]);
    expect((await rows(root) as unknown[]).length).toBe(1);
    // Do not hard-link live SQLite sidecars: APFS/SQLite correctly detects
    // that as SQLITE_IOERR_VNODE. Synthetic sidecars test the pre-open guard
    // without changing an inode used by an active connection.
    for (const suffix of ["-wal", "-shm"] as const) {
      const sidecar = `${dbPath(root)}${suffix}`;
      const alias = `${dbPath(root)}${suffix}.alias`;
      await writeFile(sidecar, "test sidecar");
      await link(sidecar, alias);
      try {
        await expect(withTaskDatabase(path.join(root, ".pi"), "read", db => db?.prepare("SELECT count(*) AS n FROM tasks").get())).rejects.toThrow("Unsafe task database sidecar");
      } finally { await unlink(alias); await unlink(sidecar); }
    }
    // Deliberately forging SQLite sidecars may invalidate VFS state on APFS.
    // Do not reopen the same database after the malicious fixture; the tested
    // contract is that the pre-open link guard rejects it before opening.
    expect((await lstat(dbPath(root))).nlink).toBe(1);
  });
  test("reads never initialize SQLite and ignore all legacy files", async () => {
    const root = await fixture();
    const folder = path.join(root, ".pi");
    await mkdir(path.join(folder, "tasks.d"), { recursive: true });
    const legacy = Buffer.from(JSON.stringify({ version: 1, tasks: [task("legacy")] }));
    await writeFile(path.join(folder, "tasks.jsonc"), legacy);
    expect((await runProjectTasks(root, { op: "list" })).tasks).toEqual([]);
    expect((await runProjectTasks(root, { op: "get", id: "legacy" }).catch(error => error.message))).toContain("Unknown project task");
    expect(await readFile(path.join(folder, "tasks.jsonc"))).toEqual(legacy);
    const created = await runProjectTasks(root, { op: "create", type: "idea", title: "SQLite only" });
    expect(created.task!.id).toBeTruthy();
    expect((await runProjectTasks(root, { op: "list" })).tasks).toHaveLength(1);
    expect(await readFile(path.join(folder, "tasks.jsonc"))).toEqual(legacy);
    expect((await readdir(path.join(folder, "tasks.d")))).toEqual([]);
  });

  test("explicit create, get, list filters, four-field update, and deletion affect one row", async () => {
    const root = await fixture([task("A"), task("B")]);
    const before = await rows(root);
    const next = await runProjectTasks(root, { op: "update", id: "A", title: "", description: "Only description", status: "failed", priority: "urgent" });
    expect(next.task).toMatchObject({ ...task("A"), title: "", description: "Only description", status: "failed", priority: "urgent", updatedAt: expect.any(String) });
    expect(next.task!.updatedAt).not.toBe(task("A").updatedAt);
    expect((await runProjectTasks(root, { op: "list", status: "failed", priority: "urgent" })).tasks!.map(t => t.id)).toEqual(["A"]);
    expect((await runProjectTasks(root, { op: "get", id: "A" })).task).toEqual(next.task);
    const after = await rows(root) as Array<Record<string, unknown>>;
    expect(after[1]).toEqual((before as Array<Record<string, unknown>>)[1]);
    expect(after[0]!.revision).toBe(2);
    await runProjectTasks(root, { op: "delete", id: "A" });
    expect((await runProjectTasks(root, { op: "list" })).tasks!.map(t => t.id)).toEqual(["B"]);
    expect((await rows(root) as Array<Record<string, unknown>>)[0]!.id).toBe("B");
  });

  test("keeps model, epic, subtask and related links on agent updates; rejects dangling deletes", async () => {
    const parent = { ...task("A"), epic: true, modelRef: "provider/smart-model:high" };
    const child = { ...task("B"), parentId: "A", relatedTaskIds: ["A"], modelRef: "provider/fast-model" };
    const root = await fixture([parent, child]);
    const saved = await runProjectTasks(root, { op: "update", id: "B", status: "in-progress" });
    expect(saved.task).toMatchObject({ parentId: "A", relatedTaskIds: ["A"], modelRef: "provider/fast-model" });
    const before = await rows(root);
    await expect(runProjectTasks(root, { op: "delete", id: "A" })).rejects.toThrow("missing");
    expect(await rows(root)).toEqual(before);
    await runProjectTasks(root, { op: "delete", id: "B" });
    await runProjectTasks(root, { op: "delete", id: "A" });
    expect((await rows(root) as unknown[]).length).toBe(0);
  });

  test("wrong fields, malformed merged values, unknown ids, duplicate id and unsupported schema are rejected", async () => {
    const root = await fixture([task()]);
    const before = await rows(root);
    for (const bad of [
      { op: "update", id: "A", type: "bug" }, { op: "update", id: "A", links: [] },
      { op: "update", id: "A", title: "", description: "" }, { op: "update", id: "A", status: "invalid" },
      { op: "update", id: "not-there", title: "Something" }, { op: "delete", id: "not-there" },
      { op: "create", title: "Missing type" }, { op: "create", type: "idea", title: "" },
    ]) {
      await expect(runProjectTasks(root, bad)).rejects.toThrow();
      expect(await rows(root)).toEqual(before);
    }
    await withTaskDatabase(path.join(root, ".pi"), "write", db => db!.exec("PRAGMA user_version=5"));
    await expect(runProjectTasks(root, { op: "list" })).rejects.toThrow("user_version");
    expect(await rows(root).catch(error => error.message)).toContain("user_version");
  });

  test("same-task race fails via revision, unrelated task edit succeeds", async () => {
    const root = await fixture([task("A"), task("B")]);
    let unblock!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>(resolve => { unblock = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    const stalled = runProjectTasks(root, { op: "update", id: "A", title: "stale" }, undefined, {
      beforeCommit: async () => { entered(); await gate; },
    });
    await started;
    await runProjectTasks(root, { op: "update", id: "B", title: "independent" });
    await runProjectTasks(root, { op: "update", id: "A", title: "winner" });
    unblock();
    await expect(stalled).rejects.toThrow("changed during update");
    expect((await runProjectTasks(root, { op: "get", id: "A" })).task!.title).toBe("winner");
    expect((await runProjectTasks(root, { op: "get", id: "B" })).task!.title).toBe("independent");
  });

  test("cancellation before SQL transaction cannot alter the selected task", async () => {
    const root = await fixture([task()]);
    const controller = new AbortController();
    await expect(runProjectTasks(root, { op: "update", id: "A", status: "done" }, controller.signal, {
      beforeCommit: async () => controller.abort(),
    })).rejects.toThrow();
    expect((await runProjectTasks(root, { op: "get", id: "A" })).task).toEqual(task());
  });

  test("refuses symlink database; old storage never used as a fallback", async () => {
    const root = await fixture();
    const outside = await fixture([task("outside")]);
    await mkdir(path.join(root, ".pi"));
    await symlink(dbPath(outside), dbPath(root));
    await expect(runProjectTasks(root, { op: "list" })).rejects.toThrow("Unsafe task database");
    expect((await runProjectTasks(outside, { op: "list" })).tasks).toHaveLength(1);
  });

  test("user /task attach copies immutable SHA-256 content and registers task association", async () => {
    const root = await fixture([task()]);
    await writeFile(path.join(root, "example.txt"), "file body");
    const item = await attachTaskFile(root, "A", "example.txt");
    expect(item.hash).toBe(createHash("sha256").update("file body").digest("hex"));
    expect(await readFile(path.join(root, ".pi", "task-attachments", item.hash), "utf8")).toBe("file body");
    expect((await runProjectTasks(root, { op: "get", id: "A" })).attachments).toEqual([item]);
    await attachTaskFile(root, "A", "example.txt");
    expect((await runProjectTasks(root, { op: "get", id: "A" })).attachments).toHaveLength(1);
    await expect(attachTaskFile(root, "A", "../private")).rejects.toThrow("relative project file");
    await expect(attachTaskFile(root, "missing", "example.txt")).rejects.toThrow("Unknown project task");
    expect(await readdir(path.join(root, ".pi", "task-attachments"))).toEqual([item.hash]);
  });

  test("slash commands are user-only and agent tool has no deletion", async () => {
    const root = await fixture([task()]);
    const commands = new Map<string, any>();
    let tool: any;
    registerProjectTasks({
      registerTool: (definition: any) => { tool = definition; },
      registerCommand: (name: string, definition: any) => commands.set(name, definition),
    } as any);
    const notices: Array<{ text: string; level: string }> = [];
    const ctx = { cwd: root, ui: { notify: (text: string, level: string) => notices.push({ text, level }) } };
    async function slash(command: string, args: string) {
      await commands.get(command).handler(args, ctx);
      return notices.at(-1)!;
    }
    expect((await slash("tasks", "list")).text).toContain('"id": "A"');
    expect((await slash("task", 'update {"id":"A","status":"done"}')).level).toBe("info");
    expect((await slash("task", "delete A")).level).toBe("info");
    expect((await runProjectTasks(root, { op: "list" })).tasks).toEqual([]);
    expect((await tool.execute("call", { op: "delete", id: "A" }, undefined, undefined, ctx)).isError).toBe(true);
    const added = await slash("task", 'add {"type":"idea","title":"New user task"}');
    expect(JSON.parse(added.text).task.title).toBe("New user task");
    expect((await tool.execute("call", { op: "list" }, undefined, undefined, ctx)).details.tasks).toHaveLength(1);
    expect(parseTaskCommand("task", "get A")).toEqual({ op: "get", id: "A" });
    expect(() => parseProjectTasksParams({ op: "delete", id: "A" })).toThrow();
    expect(() => parseTaskCommand("task", "invalid")).toThrow(TASK_COMMAND_USAGE);
    expect(MODULES.some(module => module.name === "project-tasks")).toBe(true);
  });
});
