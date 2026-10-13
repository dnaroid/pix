import { createHash } from "node:crypto";
import { lstat } from "node:fs/promises";
import { checkStorage, validateNativeStore } from "./native-store.mjs";
import { VECTOR_DEFINITIONS } from "./native-vector-store.mjs";
import { sourcePath } from "./source-work.mjs";

const hash = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const normalize = sql => sql.replace(/[\s;"`\[\]]/g, "").toLowerCase();
export const repositoryManifest = files => hash(["repository-content-v2", [...files].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)]);

/** Read one committed logical snapshot, without opening the writer/migrator.
 * Generation and lease churn are deliberately excluded from its identity. */
export async function readRepositorySnapshot(root, source, signal) {
  signal.throwIfAborted();
  const filename = sourcePath(root, source);
  try { await checkStorage(root, filename); await lstat(filename); }
  catch (error) {
    if (error.code !== "ENOENT") throw error;
    return { present: false, files: new Map(), stamps: new Map(), index: hash(["repository-index-v2", root, source, "absent"]) };
  }
  let db;
  if ("Bun" in globalThis) {
    const { Database } = await import("bun:sqlite");
    db = new Database(filename, { readonly: true });
  } else {
    const { DatabaseSync } = await import("node:sqlite");
    db = new DatabaseSync(filename, { readOnly: true });
  }
  try {
    db.exec("PRAGMA busy_timeout=0; PRAGMA query_only=ON; PRAGMA trusted_schema=OFF; BEGIN");
    const meta = validateNativeStore(db, root);
    const files = new Map();
    for (const row of db.prepare("SELECT path,hash FROM pix_native_files ORDER BY path LIMIT 10001").iterate()) {
      signal.throwIfAborted();
      if (files.size >= 10000 || typeof row.path !== "string" || row.path.length > 4096 || !/^[a-f0-9]{64}$/.test(row.hash)) throw new Error("Invalid repository manifest");
      files.set(row.path, row.hash);
    }
    const stamps = new Map();
    if (meta.version === 2) {
      for (const row of db.prepare("SELECT path,hash,stamp FROM pix_native_stamps LIMIT 10001").iterate()) {
        signal.throwIfAborted();
        if (stamps.size >= 10000 || typeof row.stamp !== "string" || row.stamp.length > 256) throw new Error("Invalid repository stamps");
        if (files.get(row.path) === row.hash) stamps.set(row.path, { ...row, kind: source });
      }
    }
    const objects = db.prepare("SELECT type,sql FROM sqlite_master WHERE name IN ('meta','vectors','leases')").all();
    const vectors = [];
    if (objects.length) {
      if (objects.length !== VECTOR_DEFINITIONS.length || VECTOR_DEFINITIONS.some(sql => !objects.some(row => row.type === "table" && normalize(row.sql || "") === normalize(sql)))) throw new Error("Unknown vector schema");
      const identities = db.prepare("SELECT singleton,version,root FROM meta").all();
      if (identities.length !== 1 || identities[0].singleton !== 1 || identities[0].version !== 1 || identities[0].root !== root) throw new Error("Unknown vector identity");
      // No vector BLOB reads. This records cache membership, not a vector audit.
      for (const row of db.prepare("SELECT identity,digest,length(vector) AS bytes FROM vectors ORDER BY identity,digest LIMIT 50001").iterate()) {
        signal.throwIfAborted();
        if (vectors.length >= 50000 || typeof row.identity !== "string" || row.identity.length > 4096
          || !/^[a-f0-9]{64}$/.test(row.digest) || !Number.isSafeInteger(row.bytes) || row.bytes <= 0) throw new Error("Invalid vector metadata");
        vectors.push([row.identity, row.digest, row.bytes]);
      }
    }
    signal.throwIfAborted();
    return { present: true, files, stamps, manifest: repositoryManifest(files),
      index: hash(["repository-index-v2", root, source, repositoryManifest(files), vectors]) };
  } finally {
    try { db.exec("ROLLBACK"); } finally { db.close(); }
  }
}
