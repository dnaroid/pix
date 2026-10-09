import { lstat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { canonicalSearchIndexPath } from "./canonical-index.js";

/** Never write private session excerpts through redirected search directories/db files. */
export async function verifySessionBoundaryIndexPath(cwd: string): Promise<void> {
  const root = resolve(cwd);
  const file = canonicalSearchIndexPath(root);
  for (const [path, directory] of [
    [join(root, ".pi"), true],
    [join(root, ".pi", "search"), true],
    [file, false],
    [`${file}-wal`, false],
    [`${file}-shm`, false],
    [`${file}-journal`, false],
  ] as const) {
    const entry = await lstat(path).catch(error => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    });
    if (entry && (entry.isSymbolicLink() || (directory ? !entry.isDirectory() : !entry.isFile()))) {
      throw new Error("Local session excerpt index path is unsafe.");
    }
  }
}
