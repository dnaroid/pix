import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { removeDirsWithRetry, withFilesystemRetry } from "./support/fs-retry.js";

const roots: string[] = [];
afterEach(() => removeDirsWithRetry(roots));
function filename() {
  const base = fileURLToPath(new URL("../../../.pi/artifacts/sqlite-cleanup-regression/", import.meta.url));
  mkdirSync(base, { recursive: true });
  const root = mkdtempSync(join(base, "fixture-")); roots.push(root);
  return join(root, "fixture.sqlite");
}
function prepareUncached(db: Database) {
  db.exec("PRAGMA journal_mode=WAL; CREATE TABLE fixture(value); INSERT INTO fixture VALUES (1)");
  const statement = db.prepare("SELECT value FROM fixture");
  expect(statement.get()).toEqual({ value: 1 });
  return statement;
}
function statementCollection() {
  let collected = false;
  const registry = new FinalizationRegistry(() => { collected = true; });
  return { registry, check() {
    // POSIX permits unlinking open files. Model Windows' EBUSY until the actual
    // unreachable SQLite statement is collected (not an arbitrary retry count).
    if (!collected) throw Object.assign(new Error("SQLite handle still owns statements"), { code: "EBUSY" });
  } };
}

test("cleanup releases unreachable uncached SQLite statements without waiting for spontaneous GC", async () => {
  const db = new Database(filename()), collection = statementCollection();
  collection.registry.register(prepareUncached(db), undefined);
  db.close();
  let attempts = 0;
  await withFilesystemRetry(() => { attempts++; collection.check(); }, 3, 0);
  expect(attempts).toBe(2);
});

test("cleanup stays bounded and never closes a still-referenced SQLite statement", async () => {
  const db = new Database(filename()), statement = prepareUncached(db), collection = statementCollection();
  collection.registry.register(statement, undefined);
  db.close(); // Default close defers release while this statement is reachable.
  try {
    await expect(withFilesystemRetry(collection.check, 2, 0)).rejects.toThrow("SQLite handle still owns statements");
    expect(statement.get()).toEqual({ value: 1 });
  } finally { statement.finalize(); db.close(); }
});

test("cleanup retries only lock errors and preserves the last failure", async () => {
  const error = Object.assign(new Error("denied"), { code: "EACCES" });
  let attempts = 0;
  await expect(withFilesystemRetry(() => { attempts++; throw error; }, 3, 0)).rejects.toBe(error);
  expect(attempts).toBe(1);
  error.code = "EPERM"; attempts = 0;
  await expect(withFilesystemRetry(() => { attempts++; throw error; }, 3, 0)).rejects.toBe(error);
  expect(attempts).toBe(3);
});
