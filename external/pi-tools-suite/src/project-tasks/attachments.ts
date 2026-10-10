import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";
import { checkChange, readTaskStore, safeDirectory, transaction, withTaskDatabase, type TaskAttachment } from "./storage.js";

const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
/** User slash command only. Never reads files for the agent tool. */
export async function attachTaskFile(cwd: string, id: string, relative: string, signal?: AbortSignal): Promise<TaskAttachment> {
  signal?.throwIfAborted();
  const root = await realpath(cwd);
  if (!relative || path.isAbsolute(relative) || relative.split(/[\\/]/).some(part => part === ".." || part === "")) throw new Error("Attachment must be a relative project file inside cwd");
  const filename = path.resolve(root, relative);
  if (!filename.startsWith(root + path.sep)) throw new Error("Attachment must be inside cwd");
  let component = root;
  for (const part of path.relative(root, filename).split(path.sep)) {
    component = path.join(component, part);
    if ((await lstat(component)).isSymbolicLink()) throw new Error("Attachment symlinks are not allowed");
  }
  if (await realpath(filename) !== filename) throw new Error("Attachment path changed; retry");
  const folder = path.join(root, ".pi");
  const snapshot = await readTaskStore(folder, signal);
  const revision = snapshot.revisions.get(id);
  if (revision === undefined) throw new Error(`Unknown project task id: ${id}`);
  const handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let bytes: Buffer;
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error("Attachment must be a regular file");
    if (info.size > MAX_ATTACHMENT_BYTES) throw new Error("Attachment exceeds 25 MB limit");
    const buffer = Buffer.alloc(MAX_ATTACHMENT_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      signal?.throwIfAborted();
      const result = await handle.read(buffer, length, buffer.length - length, length);
      if (!result.bytesRead) break;
      length += result.bytesRead;
    }
    if (length > MAX_ATTACHMENT_BYTES) throw new Error("Attachment exceeds 25 MB limit");
    if (await realpath(filename) !== filename) throw new Error("Attachment path changed; retry");
    bytes = buffer.subarray(0, length);
  } finally { await handle.close(); }
  const hash = createHash("sha256").update(bytes).digest("hex");
  const attachment = { hash, name: path.basename(filename), size: bytes.length };
  const directory = path.join(folder, "task-attachments");
  await safeDirectory(directory, true);
  const target = path.join(directory, hash);
  signal?.throwIfAborted();
  try {
    const output = await open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await output.writeFile(bytes, { signal }); await output.sync(); } finally { await output.close(); }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const existing = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const info = await existing.stat();
      if (!info.isFile() || info.size !== bytes.length || createHash("sha256").update(await existing.readFile()).digest("hex") !== hash) throw new Error("Unsafe or corrupt stored attachment");
    } finally { await existing.close(); }
  }
  signal?.throwIfAborted();
  await withTaskDatabase(folder, "write", db => {
    if (!db) throw new Error("Task database missing; retry");
    transaction(db, () => {
      checkChange(db.prepare("UPDATE tasks SET revision=revision+1 WHERE id=? AND revision=?").run(id, revision).changes);
      db.prepare("INSERT INTO attachments(hash,name,size) VALUES(?,?,?) ON CONFLICT(hash) DO NOTHING").run(hash, attachment.name, attachment.size);
      db.prepare("INSERT INTO task_attachments(task_id,hash,ordinal) VALUES(?,?,(SELECT COALESCE(MAX(ordinal),-1)+1 FROM task_attachments WHERE task_id=?)) ON CONFLICT(task_id,hash) DO NOTHING").run(id, hash, id);
    });
  });
  return attachment;
}
