import { watch, type FSWatcher } from "node:fs";
import { lstat } from "node:fs/promises";
import { join } from "node:path";

export type TaskChangeWatcher = (cwd: string, changed: () => void, failed: (error: unknown) => void) => () => void;

/** Directory plus inode watches cover creation, atomic replacement and external
 * in-place WAL writes on macOS. No polling. */
export const watchTaskChanges: TaskChangeWatcher = (cwd, changed, failed) => {
  let closed = false;
  let root: FSWatcher | undefined;
  let tasks: FSWatcher | undefined;
  let revision = 0;
  let fileRevision = 0;
  const files = new Map<string, { watcher: FSWatcher; identity: string }>();
  const closeFiles = () => { fileRevision++; for (const file of files.values()) file.watcher.close(); files.clear(); };
  const attachFiles = async () => {
    const own = ++fileRevision;
    let rebound = false;
    // On macOS directory watches report entry changes but may not report an
    // in-place WAL write. Keep inode watches too, rebinding on replacements.
    for (const name of ["tasks.sqlite", "tasks.sqlite-wal", "tasks.sqlite-journal"]) {
      try {
        const path = join(cwd, ".pi", name), stat = await lstat(path);
        if (closed || own !== fileRevision) return;
        if (!stat.isFile() || stat.isSymbolicLink()) { files.get(name)?.watcher.close(); files.delete(name); continue; }
        const identity = `${stat.dev}:${stat.ino}`;
        if (files.get(name)?.identity === identity) continue;
        files.get(name)?.watcher.close();
        const watcher = watch(path, event => {
          changed();
          if (event === "rename") void attachFiles();
        });
        watcher.on("error", error => { if (!closed) failed(error); });
        files.set(name, { watcher, identity });
        rebound = true;
      } catch (error) {
        if (closed || own !== fileRevision) return;
        if ((error as NodeJS.ErrnoException).code === "ENOENT") { files.get(name)?.watcher.close(); files.delete(name); }
        else failed(error);
      }
    }
    // An in-place write could land between the bootstrap read and binding the
    // new inode watch. Re-read once after installation closes that window.
    if (rebound && !closed && own === fileRevision) changed();
  };
  const attach = async () => {
    const own = ++revision;
    tasks?.close(); tasks = undefined;
    closeFiles();
    try {
      const path = join(cwd, ".pi");
      const directory = await lstat(path);
      if (closed || own !== revision) return;
      if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error("Unsafe task directory");
      tasks = watch(path, (_event, filename) => {
        if (!filename || /^tasks\.sqlite(?:-(?:wal|journal))?$/.test(String(filename))) { changed(); void attachFiles(); }
      });
      tasks.on("error", error => { if (!closed) failed(error); });
      void attachFiles();
      // Close the race between the root event and installing the child watch.
      changed();
    } catch (error) {
      if (!closed && own === revision && (error as NodeJS.ErrnoException).code !== "ENOENT") failed(error);
    }
  };
  try {
    root = watch(cwd, (_event, filename) => {
      if (!filename || String(filename) === ".pi") { void attach(); changed(); }
    });
    root.on("error", error => { if (!closed) failed(error); });
    void attach();
  } catch (error) { failed(error); }
  return () => { closed = true; revision++; root?.close(); tasks?.close(); closeFiles(); };
};
