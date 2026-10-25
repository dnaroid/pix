import { constants, watchFile, unwatchFile } from "node:fs";
import { lstat, open, rename, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { parseTree, getNodeValue, modify, applyEdits } from "jsonc-parser";
import { withSourcePolicyWriteLock } from "./source-policy-lock.mjs";
import { readSettingsPolicy, writeSettingsPolicy, settingsPolicyPath } from "./settings-policy.mjs";

const policyContext = new AsyncLocalStorage();
const revisionOf = stat => `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
const expectedRevision = (root, revision) => revision ?? (policyContext.getStore()?.root === resolve(root)
  ? policyContext.getStore().revision : undefined);

// Protocol twin: acp/src/search/source-policy.js (import extensions only; tested).
export const SEARCH_SOURCES = Object.freeze(["settings", "code", "knowledge", "sessions", "tasks", "commits"]);
export const DEFAULT_SEARCH_SOURCES = Object.freeze(Object.fromEntries(SEARCH_SOURCES.map(source =>
  [source, source === "settings" || source === "code"])));
const OFF = Object.freeze(Object.fromEntries(SEARCH_SOURCES.map(source => [source, false])));
const PROJECT_SOURCES = SEARCH_SOURCES.filter(source => source !== "settings");
const MAX_WORKSPACE_BYTES = 64 * 1024;
export const sourcePolicyPath = root => join(resolve(root), ".pi", "workspace.jsonc");
async function info(path) {
  return lstat(path).catch(error => { if (error.code !== "ENOENT") throw error; });
}
async function directory(path) {
  const stat = await info(path);
  if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) throw new Error("Unsafe search source policy directory");
  return stat;
}
const record = value => value !== null && typeof value === "object" && !Array.isArray(value);
function projectSelection(text) {
  const errors = [], tree = parseTree(text, errors, { allowTrailingComma: true });
  const value = tree && getNodeValue(tree);
  if (errors.length || !record(value)) throw new Error("Invalid workspace configuration");
  // Surgical edits must not target the first of two conflicting properties.
  const unique = node => {
    const keys = node?.children?.map(property => property.children[0].value) ?? [];
    return new Set(keys).size === keys.length;
  };
  const child = (node, key) => node?.children?.find(property => property.children[0].value === key)?.children[1];
  const searchNode = child(tree, "search");
  if (!unique(tree) || !unique(searchNode) || !unique(child(searchNode, "sources"))) throw new Error("Duplicate workspace search policy properties");
  const search = value.search;
  if (search !== undefined && (!record(search)
    || (search.revision !== undefined && (typeof search.revision !== "string" || search.revision.length > 128))
    || (search.sources !== undefined && (!record(search.sources)
      || Object.entries(search.sources).some(([key, value]) => !PROJECT_SOURCES.includes(key) || typeof value !== "boolean"))))) {
    throw new Error("Invalid search source policy");
  }
  const enabled = { ...DEFAULT_SEARCH_SOURCES, ...search?.sources };
  // Only search edits invalidate work. The nonce also fences disable/re-enable
  // between polling ticks; file identity remains only a torn-read check.
  return { enabled, revision: JSON.stringify([search?.revision ?? "", PROJECT_SOURCES.map(source => enabled[source])]) };
}
/** Missing policy means Settings + Code. Invalid/redirected policy fails closed;
 * reads never initialize storage or silently restore defaults over bad data. */
export async function readSourcePolicy(root) {
  try {
    const [project, settings] = await Promise.all([readProjectPolicy(root), readSettingsPolicy()]);
    const { content, ...policy } = project;
    return { ...policy, enabled: { ...project.enabled, settings: !project.error && settings.enabled },
      revision: `${project.revision}|settings:${settings.revision}` };
  } catch { return { enabled: { ...OFF }, revision: "unavailable", error: "Global Settings search preference unavailable; repair ~/.config/pi/search/settings-enabled.json or retry" }; }
}
async function readProjectPolicy(root) {
  try {
    const missing = () => ({ ...projectSelection("{}"), content: "{}\n" });
    if (!await directory(join(resolve(root), ".pi"))) return missing();
    const path = sourcePolicyPath(root), stat = await info(path);
    if (!stat) return missing();
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > MAX_WORKSPACE_BYTES) throw new Error("Unsafe search source policy");
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const opened = await handle.stat({ bigint: true });
      if (!opened.isFile() || opened.nlink !== 1n || opened.size > BigInt(MAX_WORKSPACE_BYTES)) throw new Error("Unsafe search source policy");
      // Bound allocation even if a non-cooperating writer grows the file after stat.
      const buffer = Buffer.alloc(MAX_WORKSPACE_BYTES + 1);
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
        if (!bytesRead) break;
        length += bytesRead;
      }
      if (length > MAX_WORKSPACE_BYTES || revisionOf(opened) !== revisionOf(await handle.stat({ bigint: true }))) throw new Error("Search source policy changed while reading");
      const content = buffer.toString("utf8", 0, length);
      return { ...projectSelection(content), content };
    } finally { await handle.close(); }
  } catch { return { enabled: { ...OFF }, revision: "unavailable", error: "Search source policy unavailable; repair .pi/workspace.jsonc or retry" }; }
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
  return withSourcePolicyWriteLock(root, async () => {
    const policy = await readProjectPolicy(root);
    if (policy.error) throw new Error(policy.error);
    if (policy.enabled[source] === enabled) return readSourcePolicy(root);
    const formattingOptions = { insertSpaces: true, tabSize: 2, eol: policy.content.includes("\r\n") ? "\r\n" : "\n" };
    let content = applyEdits(policy.content, modify(policy.content, ["search", "sources", source], enabled, { formattingOptions }));
    content = applyEdits(content, modify(content, ["search", "revision"], randomUUID(), { formattingOptions }));
    await installWorkspaceConfig(root, content);
    return await readSourcePolicy(root);
  });
}
/** Registry installs a whole document under the same mutex as source and Desktop
 * edits. Its conflict check must run inside verify, never before locking alone. */
export async function replaceWorkspaceConfig(root, content, verify) {
  return withSourcePolicyWriteLock(root, async () => {
    await verify();
    const next = projectSelection(content), current = await readProjectPolicy(root);
    if (current.error) throw new Error(current.error);
    const unchanged = PROJECT_SOURCES.every(source => next.enabled[source] === current.enabled[source]);
    const nonce = unchanged ? JSON.parse(current.revision)[0] : randomUUID();
    const formattingOptions = { insertSpaces: true, tabSize: 2 };
    content = applyEdits(content, modify(content, ["search", "revision"], nonce, { formattingOptions }));
    await installWorkspaceConfig(root, content);
    return content;
  });
}
async function installWorkspaceConfig(root, content) {
  if (Buffer.byteLength(content) > MAX_WORKSPACE_BYTES) throw new Error("Workspace configuration is too large");
  const path = sourcePolicyPath(root), parent = join(resolve(root), ".pi");
  const temp = join(parent, `.workspace.jsonc.${randomUUID()}.tmp`);
  try {
    const handle = await open(temp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    try { await handle.writeFile(content); await handle.sync(); }
    finally { await handle.close(); }
    await directory(parent);
    if ((await readProjectPolicy(root)).error) throw new Error("Unsafe workspace configuration");
    await rename(temp, path);
    if (process.platform !== "win32") {
      const handle = await open(parent, constants.O_RDONLY | constants.O_NOFOLLOW);
      try { await handle.sync(); } finally { await handle.close(); }
    }
  } finally { await unlink(temp).catch(() => {}); }
}
export function watchSourcePolicy(root, changed) {
  const files = [sourcePolicyPath(root), settingsPolicyPath()];
  let disposed = false, pending = false, reading = false;
  let previous = readSourcePolicy(root);
  const refresh = async () => {
    pending = true;
    if (reading) return;
    reading = true;
    try {
      while (pending && !disposed) {
        pending = false;
        const before = await previous;
        const next = readSourcePolicy(root);
        previous = next;
        const after = await next;
        if (!disposed && (before.revision !== after.revision || before.error !== after.error)) changed();
      }
    } finally { reading = false; }
  };
  const listener = (current, previous) => {
    if (current.mtimeMs !== previous.mtimeMs || current.ctimeMs !== previous.ctimeMs
      || current.ino !== previous.ino || current.size !== previous.size || current.nlink !== previous.nlink) void refresh();
  };
  for (const file of files) watchFile(file, { persistent: false, interval: 250 }, listener);
  return () => { disposed = true; for (const file of files) unwatchFile(file, listener); };
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
