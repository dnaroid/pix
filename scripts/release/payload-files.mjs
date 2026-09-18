import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readdir, readFile, readlink } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

/** List regular files and links without ever following directory links. */
export async function* files(directory, { skipModules = false } = {}) {
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!skipModules || entry.name !== "node_modules") yield* files(path, { skipModules });
    } else if (entry.isFile() || entry.isSymbolicLink()) {
      yield { path, stat: await lstat(path) };
    } else throw new Error(`Unsupported payload entry: ${path}`);
  }
}

/** Installed package roots only; package aliases must not point outside the payload. */
export async function packages(directory) {
  const result = [];
  async function modules(path) {
    let entries;
    try { entries = await readdir(path, { withFileTypes: true }); }
    catch (error) { if (error.code === "ENOENT") return; throw error; }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith(".")) continue;
      const child = join(path, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Linked dependency is not a portable package: ${child}`);
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith("@")) { await modules(child); continue; }
      const manifest = JSON.parse(await readFile(join(child, "package.json"), "utf8"));
      result.push({ path: child, manifest });
      await modules(join(child, "node_modules"));
    }
  }
  await modules(join(directory, "node_modules"));
  return result;
}

export async function bytes(directory) {
  let size = 0;
  for await (const entry of files(directory)) if (entry.stat.isFile()) size += entry.stat.size;
  return size;
}

/** Content/mode identity, independent of install path and filesystem timestamps. */
export async function ownDigest(directory) {
  const hash = createHash("sha256");
  for await (const { path, stat } of files(directory, { skipModules: true })) {
    hash.update(JSON.stringify([relative(directory, path).split(sep).join("/"), stat.mode & 0o111, stat.isSymbolicLink()]));
    if (stat.isSymbolicLink()) hash.update(await readlink(path));
    else for await (const chunk of createReadStream(path)) hash.update(chunk);
    hash.update("\0");
  }
  return hash.digest("hex");
}

export function inside(parent, child) {
  const path = relative(resolve(parent), resolve(child));
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}
