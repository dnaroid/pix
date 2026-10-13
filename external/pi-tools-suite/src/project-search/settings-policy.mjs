import { constants } from "node:fs";
import { lstat, open, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { globalSearchDirectory, sourceDirectories, safeDirectory, safeFile } from "./source-work.mjs";

export const settingsPolicyPath = () => join(globalSearchDirectory(), "settings-enabled.json");
const revision = value => `${value.dev}:${value.ino}:${value.size}:${value.mtimeNs}:${value.ctimeNs}`;
export async function readSettingsPolicy() {
  for (const path of sourceDirectories("", "settings")) {
    const info = await lstat(path).catch(error => { if (error.code !== "ENOENT") throw error; });
    if (!info) return { enabled: true, revision: "missing" };
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Unsafe global Settings search directory");
  }
  const path = settingsPolicyPath();
  await safeFile(path);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW).catch(error => { if (error.code !== "ENOENT") throw error; });
  if (!handle) return { enabled: true, revision: "missing" };
  try {
    const before = await handle.stat({ bigint: true });
    if (before.size > 1024n) throw new Error("Invalid Settings search preference");
    const buffer = Buffer.alloc(1025);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > 1024 || revision(before) !== revision(await handle.stat({ bigint: true }))) throw new Error("Settings search preference changed");
    const value = JSON.parse(buffer.toString("utf8", 0, bytesRead));
    if (value?.version !== 1 || typeof value.enabled !== "boolean" || Object.keys(value).length !== 2) throw new Error("Invalid Settings search preference");
    return { enabled: value.enabled, revision: revision(before) };
  } finally { await handle.close(); }
}
/** Single global boolean: atomic last-save wins, with no unrelated fields to merge. */
export async function writeSettingsPolicy(enabled) {
  if (typeof enabled !== "boolean") throw new Error("Invalid Settings search preference");
  for (const directory of sourceDirectories("", "settings")) await safeDirectory(directory);
  await readSettingsPolicy();
  const path = settingsPolicyPath(), temp = `${path}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    try { await handle.writeFile(JSON.stringify({ version: 1, enabled }) + "\n"); await handle.sync(); }
    finally { await handle.close(); }
    for (const directory of sourceDirectories("", "settings")) await safeDirectory(directory);
    await safeFile(path);
    await rename(temp, path);
  } finally { await unlink(temp).catch(() => {}); }
}
