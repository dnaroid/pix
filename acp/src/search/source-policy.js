import { constants, watchFile, unwatchFile } from "node:fs";
import { lstat, open, rename, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { withSourcePolicyWriteLock } from "./source-policy-lock.js";
import { readSettingsPolicy, writeSettingsPolicy, settingsPolicyPath } from "./settings-policy.js";

const policyContext = new AsyncLocalStorage();
const revisionOf = stat => `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
const expectedRevision = (root, revision) => revision ?? (policyContext.getStore()?.root === resolve(root)
  ? policyContext.getStore().revision : undefined);

// Protocol twin: acp/src/search/source-policy.js (import extensions only; tested).
export const SEARCH_SOURCES = Object.freeze(["settings", "code", "knowledge", "sessions", "tasks", "commits"]);
export const DEFAULT_SEARCH_SOURCES = Object.freeze(Object.fromEntries(SEARCH_SOURCES.map(source =>
  [source, source === "settings" || source === "code"])));
const OFF = Object.freeze(Object.fromEntries(SEARCH_SOURCES.map(source => [source, false])));
export const sourcePolicyPath = root => join(resolve(root), ".pi", "search-sources.json");
async function info(path) {
  return lstat(path).catch(error => { if (error.code !== "ENOENT") throw error; });
}
async function directory(path) {
  const stat = await info(path);
  if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) throw new Error("Unsafe search source policy directory");
  return stat;
}
function validate(value) {
  if (!value || value.version !== 1 || !value.enabled || typeof value.enabled !== "object"
    || Array.isArray(value.enabled) || Object.keys(value.enabled).some(source => !SEARCH_SOURCES.includes(source))
    || SEARCH_SOURCES.some(source => typeof value.enabled[source] !== "boolean")) throw new Error("Invalid search source policy");
  return Object.fromEntries(SEARCH_SOURCES.map(source => [source, value.enabled[source]]));
}
/** Missing policy means Settings + Code. Invalid/redirected policy fails closed;
 * reads never initialize storage or silently restore defaults over bad data. */
export async function readSourcePolicy(root) {
  try {
    const [project, settings] = await Promise.all([readProjectPolicy(root), readSettingsPolicy()]);
    return { ...project, enabled: { ...project.enabled, settings: !project.error && settings.enabled },
      revision: `${project.revision}|settings:${settings.revision}` };
  } catch { return { enabled: { ...OFF }, revision: "unavailable", error: "Global Settings search preference unavailable; repair ~/.config/pi/search/settings-enabled.json or retry" }; }
}
async function readProjectPolicy(root) {
  try {
    if (!await directory(join(resolve(root), ".pi"))) return { enabled: { ...DEFAULT_SEARCH_SOURCES }, revision: "missing" };
    const path = sourcePolicyPath(root), stat = await info(path);
    if (!stat) return { enabled: { ...DEFAULT_SEARCH_SOURCES }, revision: "missing" };
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 8192) throw new Error("Unsafe search source policy");
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const opened = await handle.stat({ bigint: true });
      if (!opened.isFile() || opened.nlink !== 1n || opened.size > 8192n) throw new Error("Unsafe search source policy");
      // Bound allocation even if a non-cooperating writer grows the file after stat.
      const buffer = Buffer.alloc(8193);
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
        if (!bytesRead) break;
        length += bytesRead;
      }
      if (length > 8192 || revisionOf(opened) !== revisionOf(await handle.stat({ bigint: true }))) throw new Error("Search source policy changed while reading");
      return { enabled: validate(JSON.parse(buffer.toString("utf8", 0, length))), revision: revisionOf(opened) };
    } finally { await handle.close(); }
  } catch { return { enabled: { ...OFF }, revision: "unavailable", error: "Search source policy unavailable; repair .pi/search-sources.json or retry" }; }
}
export async function sourceEnabled(root, source, revision) {
  const policy = await readSourcePolicy(root), expected = expectedRevision(root, revision);
  return (expected === undefined || expected === policy.revision) && policy.enabled[source] === true;
}
export async function requireSourceEnabled(root, source, signal, revision) {
  signal?.throwIfAborted();
  const policy = await readSourcePolicy(root), expected = expectedRevision(root, revision);
  if (expected !== undefined && expected !== policy.revision) throw new Error("Search source selection changed");
  if (policy.error) throw new Error(policy.error);
  if (!policy.enabled[source]) throw new Error(`Search source ${source} is disabled for this project`);
  signal?.throwIfAborted();
}
/** Atomic per-source update. Kernel-owned serialization survives crashes
 * without stealing a suspended writer or depending on a stale-file timeout. */
export async function writeSourcePolicy(root, source, enabled) {
  if (!SEARCH_SOURCES.includes(source) || typeof enabled !== "boolean") throw new Error("Invalid search source selection");
  if (source === "settings") { await writeSettingsPolicy(enabled); return readSourcePolicy(root); }
  const parent = join(resolve(root), ".pi");
  return withSourcePolicyWriteLock(root, async () => {
    const path = sourcePolicyPath(root), temp = path + "." + randomUUID() + ".tmp";
    try {
      const policy = await readProjectPolicy(root);
      if (policy.error) throw new Error(policy.error);
      if (policy.enabled[source] === enabled) return readSourcePolicy(root);
      policy.enabled[source] = enabled;
      const handle = await open(temp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
      try { await handle.writeFile(JSON.stringify({ version: 1, enabled: policy.enabled }, null, 2) + "\n"); await handle.sync(); }
      finally { await handle.close(); }
      await directory(parent);
      await rename(temp, path);
      return await readSourcePolicy(root);
    } finally { await unlink(temp).catch(() => {}); }
  });
}
export function watchSourcePolicy(root, changed) {
  const files = [sourcePolicyPath(root), settingsPolicyPath()];
  const listener = (current, previous) => {
    if (current.mtimeMs !== previous.mtimeMs || current.ctimeMs !== previous.ctimeMs
      || current.ino !== previous.ino || current.size !== previous.size || current.nlink !== previous.nlink) changed();
  };
  for (const file of files) watchFile(file, { persistent: false, interval: 250 }, listener);
  return () => { for (const file of files) unwatchFile(file, listener); };
}
/** Fence a search/index operation on changes, including enable-after-disable.
 * Callers still recheck immediately before sending/publishing provider work. */
export async function withSourcePolicy(root, caller, run) {
  const owner = new AbortController();
  const unwatch = watchSourcePolicy(root, () => owner.abort(new Error("Search source selection changed")));
  try {
    const signal = AbortSignal.any([caller, owner.signal]);
    signal.throwIfAborted();
    const before = await readSourcePolicy(root);
    // The owning query formats an invalid-policy diagnostic into its typed
    // response. Authorization still fails closed at every source checkpoint.
    const expected = expectedRevision(root);
    if (expected !== undefined && expected !== before.revision) throw new Error("Search source selection changed");
    const result = await policyContext.run({ root: resolve(root), revision: before.revision }, () => run(signal));
    signal.throwIfAborted();
    const after = await readSourcePolicy(root);
    if (before.revision !== after.revision || JSON.stringify(before.enabled) !== JSON.stringify(after.enabled)) throw new Error("Search source selection changed");
    return result;
  }
  finally { unwatch(); }
}
