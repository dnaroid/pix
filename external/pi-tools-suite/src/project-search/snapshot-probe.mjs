/** Bounded local observations: reuse published content hashes when stat identity
 * matches; never embed, discover SDK sessions, create or update an index. */
import { createHash } from "node:crypto";
import { lstat, open, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { scanProject } from "./native-scan.mjs";
import { SessionCandidateCatalog } from "./session-discovery.mjs";
import { readSessionIndexRevision } from "./session-index-revision.mjs";
import { semanticConfigurationPath, repositoryEmbeddingSettings } from "./native-embedding-provider.mjs";
import { readSourcePolicy } from "./source-policy.mjs";
import { sourcePath, sourceDirectories } from "./source-work.mjs";
import { taskSnapshot } from "./task-snapshot.mjs";
import { readRepositorySnapshot, repositoryManifest } from "./repository-snapshot.mjs";

const exec = promisify(execFile);
const SOURCES = ["code", "knowledge", "settings", "sessions", "tasks", "commits"];
const hash = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const identity = s => `${s.dev}:${s.ino}:${s.size}:${s.mtimeMs}:${s.ctimeMs}`;
const MAX_ENTRIES = 10000;
const SAFE_FAILURES = new Set([
  "Unsafe file", "Unbounded or changed map", "Unsafe session directory", "Session bound",
  "Invalid session map", "Invalid session path", "Invalid HEAD", "Source disabled or unavailable",
  "Scan incomplete", "Catalogue unknown", "Index changed during check", "Configuration changed",
  "Session creation time unavailable", "Session changed during check",
]);

async function stamp(filename, emptyIsAbsent = false) {
  try {
    const info = await lstat(filename);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || await realpath(filename) !== filename) throw new Error("Unsafe file");
    // Read-only SQLite connections may create empty sidecars without index changes.
    if (emptyIsAbsent && info.size === 0) return "absent";
    return identity(info);
  } catch (error) { if (error.code === "ENOENT") return "absent"; throw error; }
}
async function databaseStamp(filename) {
  return Promise.all([stamp(filename), stamp(`${filename}-wal`, true), stamp(`${filename}-journal`, true)]);
}
async function boundedJson(filename, signal) {
  const before = await stamp(filename);
  if (before === "absent") return undefined;
  const handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = await handle.stat();
    if (identity(opened) !== before || opened.size > 4 * 1024 * 1024) throw new Error("Unbounded or changed map");
    const bytes = Buffer.alloc(opened.size + 1);
    let size = 0;
    while (size < bytes.length) {
      signal.throwIfAborted();
      const { bytesRead } = await handle.read(bytes, size, bytes.length - size, size);
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (size === bytes.length || await stamp(filename) !== before) throw new Error("Unbounded or changed map");
    return JSON.parse(bytes.subarray(0, size).toString("utf8"));
  } finally { await handle.close(); }
}
async function sessionStamp(root, signal) {
  const home = process.env.HOME?.trim() || homedir();
  const agent = process.env.PI_CODING_AGENT_DIR?.replace(/^~(?=\/|$)/, home) || path.join(home, ".pi/agent");
  const map = await boundedJson(process.env.PIX_ACP_SESSION_MAP || path.join(homedir(), ".pi/agent/pix-acp/sessions.json"), signal);
  if (map && (map.version !== 1 || !Array.isArray(map.sessions) || map.sessions.length > MAX_ENTRIES)) throw new Error("Invalid session map");
  const records = (map?.sessions ?? []).filter(record => record.cwd === root);
  for (const record of records) {
    if (typeof record.piSessionPath !== "string" || !path.isAbsolute(record.piSessionPath)) throw new Error("Invalid session path");
  }
  const catalog = new SessionCandidateCatalog({ watching: false });
  try { return await catalog.snapshot(root, agent, signal, records.map(r => r.piSessionPath), records); }
  finally { catalog.dispose(); }
}
async function commitStamp(root, signal) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
  env.GIT_OPTIONAL_LOCKS = "0";
  env.GIT_TERMINAL_PROMPT = "0";
  const git = async args => (await exec("git", ["-c", "core.fsmonitor=false", ...args],
    { cwd: root, env, signal, timeout: 2000, maxBuffer: 128 * 1024 })).stdout.trim();
  const head = await git(["rev-parse", "--verify", "HEAD"]);
  if (!/^[a-f0-9]{40,64}$/.test(head)) throw new Error("Invalid HEAD");
  const replacements = await git(["for-each-ref", "--format=%(refname) %(objectname)", "refs/replace/"]);
  const shallow = path.resolve(root, await git(["rev-parse", "--git-path", "shallow"]));
  const grafts = path.resolve(root, await git(["rev-parse", "--git-path", "info/grafts"]));
  return [head, replacements, await stamp(shallow), await stamp(grafts)];
}

export async function probeSnapshots(root, request, signal = AbortSignal.timeout(4000)) {
  const sources = request?.sources;
  if (request?.operation !== "snapshot-probe" || !Array.isArray(sources) || !sources.length || sources.length > 6
    || new Set(sources).size !== sources.length || sources.some(source => !SOURCES.includes(source))
    || (request.settingsDigest !== undefined && !/^[a-f0-9]{64}$/.test(request.settingsDigest))
    || (request.sessionSnapshot !== undefined && (typeof request.sessionSnapshot !== "string" || !/^[a-f0-9]{64}$/.test(request.sessionSnapshot)))
    || Object.keys(request).some(key => !["operation", "sources", "settingsDigest", "sessionSnapshot"].includes(key))) throw new Error("Invalid probe");
  root = path.resolve(root);
  if (await realpath(root) !== root) throw new Error("Unsafe root");
  const policy = await readSourcePolicy(root);
  const config = await stamp(semanticConfigurationPath());
  const checkedAt = Date.now();
  const observations = {};
  const initialStores = new Map();
  const repositories = new Map();
  const repositorySettings = sources.some(source => source === "code" || source === "knowledge") ? await repositoryEmbeddingSettings(root) : undefined;
  for (const source of sources) {
    try {
      for (const directory of sourceDirectories(root, source)) {
        const info = await lstat(directory).catch(error => { if (error.code !== "ENOENT") throw error; });
        if (info && (!info.isDirectory() || info.isSymbolicLink())) throw new Error("Unsafe file");
      }
      if (source === "code" || source === "knowledge") {
        if (policy.enabled[source] && !policy.error) repositories.set(source, await readRepositorySnapshot(root, source, signal));
      } else if (source === "sessions") initialStores.set(source, await readSessionIndexRevision(root, signal));
      else initialStores.set(source, await databaseStamp(sourcePath(root, source)));
    } catch { /* Per-source error below. */ }
  }
  let files;
  // Share Git enumeration and the stat walk across both repository sources.
  if (sources.some(source => ["code", "knowledge"].includes(source) && policy.enabled[source]) && !policy.error) {
    try {
      const previous = { files: new Map(), stamps: new Map() };
      for (const store of repositories.values()) {
        for (const [name, value] of store.files) previous.files.set(name, value);
        for (const [name, value] of store.stamps) previous.stamps.set(name, value);
      }
      files = await scanProject(root, previous, Date.now() + 3000, signal,
        sources.includes("code") && policy.enabled.code && sources.includes("knowledge") && policy.enabled.knowledge ? undefined
          : sources.includes("code") && policy.enabled.code ? "code" : "knowledge", true);
    } catch { /* Uncertainty is per source, never an empty successful snapshot. */ }
  }
  for (const source of sources) {
    try {
      signal.throwIfAborted();
      if (policy.error || !policy.enabled[source]) throw new Error("Source disabled or unavailable");
      let revision;
      if (source === "code" || source === "knowledge") {
        if (!files?.complete) throw new Error("Scan incomplete");
        const before = repositories.get(source);
        const after = await readRepositorySnapshot(root, source, signal);
        if (!before || before.index !== after.index) throw new Error("Index changed during check");
        const manifest = repositoryManifest([...files.files].filter(([, value]) => value.kind === source).map(([name, value]) => [name, value.hash]));
        signal.throwIfAborted();
        if (await stamp(semanticConfigurationPath()) !== config || (await readSourcePolicy(root)).revision !== policy.revision) throw new Error("Configuration changed");
        const embeddingIdentity = repositorySettings?.configs[source]?.identity ?? null;
        observations[source] = { source: hash(["repository-source-v2", root, source, manifest, embeddingIdentity]),
          index: hash([after.index, embeddingIdentity]), indexPresent: after.present,
          ...(after.present ? { matchesIndex: manifest === after.manifest } : {}), checkedAt };
        continue;
      } else if (source === "settings") {
        if (!request.settingsDigest) throw new Error("Catalogue unknown");
        revision = request.settingsDigest;
      } else if (source === "tasks") revision = await taskSnapshot(path.join(root, ".pi/tasks.sqlite"), signal);
      else if (source === "sessions") revision = request.sessionSnapshot ?? await sessionStamp(root, signal);
      else revision = await commitStamp(root, signal);
      const store = source === "sessions" ? await readSessionIndexRevision(root, signal) : await databaseStamp(sourcePath(root, source));
      const initialStore = initialStores.get(source);
      if (!initialStore || hash(initialStore) !== hash(store)) throw new Error("Index changed during check");
      signal.throwIfAborted();
      if (await stamp(semanticConfigurationPath()) !== config || (await readSourcePolicy(root)).revision !== policy.revision) throw new Error("Configuration changed");
      const sourceRevision = source === "settings" ? [2, source, revision, config] : [1, root, source, revision, config, policy.revision];
      observations[source] = { source: hash(sourceRevision), index: hash(store), indexPresent: source === "sessions" ? store.present : store[0] !== "absent", checkedAt };
    } catch (error) {
      observations[source] = { checkedAt, error: signal.aborted ? "Metadata check timed out or was cancelled"
        : SAFE_FAILURES.has(error?.message) ? error.message : "Cheap change check unavailable, incomplete, or source disabled" };
    }
  }
  return { observations };
}
