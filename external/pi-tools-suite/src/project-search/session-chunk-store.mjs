import { join, resolve } from "node:path";
import { lstat } from "node:fs/promises";
import { openDatabase, safeDirectory, safeFile, sourcePath } from "./source-work.mjs";

export const SESSION_CHUNK_FORMAT = "indexed-ranges-v1";
export const INDEX_META = "pix_session_indexed_files";
export const RANGES = "pix_session_chunk_ranges";
export const exists = (db, name) => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE name=?").get(name));
export async function storage(root, create) {
  root = resolve(root);
  for (const path of [join(root,".pi"),join(root,".pi/search")]) {
    if (create) await safeDirectory(path);
    else {
      const s = await lstat(path).catch(() => undefined);
      if (!s) return;
      if (!s.isDirectory() || s.isSymbolicLink()) throw new Error("Unsafe session index directory");
    }
  }
  const file = sourcePath(root,"sessions");
  await safeFile(file);
  if (!create && !await lstat(file).catch(() => undefined)) return;
  return openDatabase(file, { readOnly: !create });
}
export const valid = (vector, dimension) => Array.isArray(vector) && vector.length === dimension
  && vector.every(value=>Number.isFinite(value) && Number.isFinite(Math.fround(value)))
  && vector.some(value => Math.fround(value) !== 0);
export function decode(bytes, dimension) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength !== dimension * 4) return;
  const b = Buffer.from(bytes), v = Array.from({length:dimension},(_,i)=>b.readFloatLE(i*4));
  return valid(v,dimension) ? v : undefined;
}
