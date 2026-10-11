import { constants } from "node:fs";
import { lstat, open, opendir, realpath } from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import ignore from "ignore";
import { readSourceExtensions, sourceKind } from "./native-source-config.mjs";

const exec = promisify(execFile);
export const SCAN_LIMITS = Object.freeze({ files: 10000, entries: 50000, fileBytes: 1024 * 1024,
  totalBytes: 32 * 1024 * 1024, chunks: 20000, chunkChars: 8000, deadlineMs: 30000, gitBytes: 4 * 1024 * 1024 });
const excluded = new Set([".pi", ".git", ".godot", ".indexer-cli", "node_modules", "dist", "build", "target", "coverage",
  ".next", ".nuxt", ".svelte-kit", ".output", "out", ".turbo", ".parcel-cache", ".cache", ".artifacts",
  "vendor", "__pycache__", ".pytest_cache", ".mypy_cache", ".ruff_cache", ".venv", "venv", ".tox", ".gradle", "obj"]);
const decoder = new TextDecoder("utf-8", { fatal: true });
const inside = (root, filename) => filename.startsWith(root + path.sep);
const safePath = name => !!name && !name.includes("\0") && !name.includes("\\") && !name.startsWith("/")
  && !name.split("/").some(part => !part || part === "." || part === ".." || excluded.has(part));
const identity = info => `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;

/** Reject linked ancestors as well as leaf files. Open with NOFOLLOW and verify
 * inode/link metadata before and after reading, never trusting Git's path list. */
export async function readSafeFile(root, name, maxBytes = SCAN_LIMITS.fileBytes) {
  if (!safePath(name)) throw new Error("Unsafe source path");
  const filename = path.resolve(root, name);
  if (!inside(root, filename)) throw new Error("Source escapes project");
  let folder = root;
  for (const component of name.split("/").slice(0, -1)) {
    folder = path.join(folder, component);
    const info = await lstat(folder);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Linked source ancestor");
  }
  const before = await lstat(filename);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) throw new Error("Linked or nonregular source");
  if (before.size > maxBytes) throw new Error("Oversize source");
  if (await realpath(filename) !== filename) throw new Error("Redirected source");
  const handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.nlink !== 1 || identity(opened) !== identity(before)) throw new Error("Source changed while opening");
    const buffer = Buffer.alloc(maxBytes + 1);
    let size = 0;
    while (size < buffer.length) {
      const result = await handle.read(buffer, size, buffer.length - size, size);
      if (!result.bytesRead) break;
      size += result.bytesRead;
    }
    if (size > maxBytes) throw new Error("Oversize source");
    const after = await handle.stat();
    if (after.nlink !== 1 || identity(after) !== identity(before) || identity(await lstat(filename)) !== identity(before)) throw new Error("Source changed while reading");
    const bytes = buffer.subarray(0, size);
    if (bytes.some(byte => (byte < 32 && byte !== 9 && byte !== 10 && byte !== 13) || byte === 127)) throw new Error("Binary source");
    const text = decoder.decode(bytes);
    return { text, bytes: size, hash: createHash("sha256").update(bytes).digest("hex"), identity: identity(before) };
  } finally { await handle.close(); }
}

function chunksFor(name, kind, text) {
  const lines = text.split("\n");
  // The last empty split item is not an additional physical source line.
  if (lines.length > 1 && lines.at(-1) === "") lines.pop();
  const starts = [0];
  if (kind === "knowledge") {
    let fenced = false;
    for (let i = 0; i < lines.length; i++) {
      if (/^\s*(```|~~~)/.test(lines[i])) fenced = !fenced;
      if (!fenced && /^#{1,6}\s+\S/.test(lines[i]) && i > 0) starts.push(i);
    }
  }
  starts.push(lines.length);
  const result = [];
  let heading = name;
  for (let section = 0; section < starts.length - 1; section++) {
    if (kind === "knowledge" && /^#{1,6}\s+/.test(lines[starts[section]])) heading = lines[starts[section]].replace(/^#+\s+/, "").trim();
    for (let start = starts[section]; start < starts[section + 1];) {
      let end = start, chars = 0;
      while (end < starts[section + 1] && end < start + 60 && chars + lines[end].length + 1 <= SCAN_LIMITS.chunkChars) {
        chars += lines[end].length + 1; end++;
      }
      if (end === start) throw new Error("Source line exceeds chunk bound");
      result.push({ id: `${kind}:${name}:${start + 1}-${end}`, kind, title: heading,
        startLine: start + 1, endLine: end, content: lines.slice(start, end).join("\n"),
        isTest: /(^|\/)(test|tests|__tests__|fixtures)(\/|$)|\.(test|spec)\./i.test(name) });
      if (end === starts[section + 1]) break;
      start = Math.max(start + 1, end - 10);
    }
  }
  return result;
}

/** Tracked deletions are valid only if they are still absent at validation time. */
export async function validateMissingSources(root, names, deadline) {
  for (const name of names) {
    if (Date.now() >= deadline) return false;
    try { await lstat(path.join(root, name)); return false; }
    catch (error) { if (error.code !== "ENOENT") return false; }
  }
  return true;
}

export async function scanProject(root, previous, deadline = Date.now() + SCAN_LIMITS.deadlineMs, signal, source) {
  const extensions = await readSourceExtensions();
  const files = new Map(), notices = [], validations = [], missing = [];
  let complete = true, entries = 0, totalBytes = 0, chunkCount = 0, skipped = 0, updatedFiles = 0;
  const bounded = () => {
    signal?.throwIfAborted();
    if (Date.now() >= deadline || entries >= SCAN_LIMITS.entries || files.size >= SCAN_LIMITS.files) {
      complete = false; return false;
    }
    return true;
  };
  async function consume(name) {
    if (!safePath(name)) return;
    const kind = sourceKind(name, extensions);
    if (!kind || (source && kind !== source)) return;
    try {
      const file = await readSafeFile(root, name);
      totalBytes += file.bytes;
      if (totalBytes > SCAN_LIMITS.totalBytes) { complete = false; return; }
      // Classification changes must rechunk even when the source bytes are unchanged.
      const hash = createHash("sha256").update(`${kind}:${file.hash}`).digest("hex");
      const changed = previous.files.get(name) !== hash;
      const chunks = changed ? chunksFor(name, kind, file.text) : undefined;
      chunkCount += chunks?.length ?? previous.chunkCounts?.get(name) ?? chunksFor(name, kind, file.text).length;
      if (chunkCount > SCAN_LIMITS.chunks) { complete = false; return; }
      files.set(name, { hash, chunks });
      validations.push([name, file.identity]);
      if (changed) updatedFiles++;
    } catch (e) {
      if (e.code === "ENOENT") { missing.push(name); return; } // Revalidate tracked deletions before publication.
      skipped++;
      // Deliberate exclusions are not a failed scan; actual I/O/races are.
      if (!["Linked or nonregular source", "Linked source ancestor", "Redirected source", "Oversize source", "Binary source", "Source line exceeds chunk bound"]
        .includes(e.message) && !(e instanceof TypeError && e.code === "ERR_ENCODING_INVALID_ENCODED_DATA")) complete = false;
    }
  }
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
  // Do not accidentally inherit an enclosing checkout's ignore rules for an
  // explicitly selected independent project (including test/artifact roots).
  env.GIT_CEILING_DIRECTORIES = path.dirname(root);
  env.GIT_OPTIONAL_LOCKS = "0";
  env.GIT_TERMINAL_PROMPT = "0";
  const gitOptions = ["-c", "core.fsmonitor=false", "-c", "core.untrackedCache=false"];
  let gitPaths;
  try {
    const info = await exec("git", [...gitOptions, "rev-parse", "--show-toplevel"], { cwd: root, env, signal, timeout: 3000, maxBuffer: 8192 });
    const gitRoot = await realpath(info.stdout.trim());
    // Run against a containing worktree too; output is relative to selected root.
    if (root === gitRoot || inside(gitRoot, root)) {
      try {
        const result = await exec("git", [...gitOptions, "ls-files", "--cached", "--others", "--exclude-standard", "-z", "--", "."],
          { cwd: root, env, signal, encoding: "buffer", timeout: Math.min(5000, Math.max(1, deadline - Date.now())), maxBuffer: SCAN_LIMITS.gitBytes });
        gitPaths = [...new Set(decoder.decode(result.stdout).split("\0").filter(Boolean))].sort();
      } catch { complete = false; notices.push("Git file enumeration failed or exceeded its bound."); gitPaths = []; }
    }
  } catch (e) {
    if (e.code !== "ENOENT" && e.code !== 128) { complete = false; notices.push("Git root detection failed."); }
  }
  if (gitPaths) {
    for (const name of gitPaths) {
      if (!bounded() || totalBytes > SCAN_LIMITS.totalBytes || chunkCount > SCAN_LIMITS.chunks) break;
      entries++; await consume(name);
    }
  } else {
    async function walk(folder, relative, rules, depth) {
      if (!bounded()) return;
      if (depth > 64) { complete = false; return; }
      const scoped = [...rules];
      try {
        const ignoreName = relative ? `${relative}/.gitignore` : ".gitignore";
        const content = await readSafeFile(root, ignoreName, 64 * 1024);
        totalBytes += content.bytes;
        validations.push([ignoreName, content.identity]);
        if (totalBytes > SCAN_LIMITS.totalBytes) { complete = false; return; }
        scoped.push({ base: relative, matcher: ignore().add(content.text) });
      } catch (e) {
        if (e.code === "ENOENT") missing.push(relative ? `${relative}/.gitignore` : ".gitignore");
        else { complete = false; notices.push("An ignore file could not be read safely."); }
      }
      let directory;
      try {
        directory = await opendir(folder);
        for await (const entry of directory) {
          if (!bounded() || totalBytes > SCAN_LIMITS.totalBytes || chunkCount > SCAN_LIMITS.chunks) break;
          entries++;
          if (excluded.has(entry.name) || entry.isSymbolicLink()) continue;
          const name = relative ? `${relative}/${entry.name}` : entry.name;
          let ignored = false;
          for (const rule of scoped) {
            const local = rule.base ? name.slice(rule.base.length + 1) : name;
            const result = rule.matcher.test(local + (entry.isDirectory() ? "/" : ""));
            if (result.ignored) ignored = true;
            if (result.unignored) ignored = false;
          }
          if (ignored) continue;
          if (entry.isDirectory()) {
            const info = await lstat(path.join(root, name));
            if (!info.isSymbolicLink() && info.isDirectory() && await realpath(path.join(root, name)) === path.join(root, name)) {
              await walk(path.join(root, name), name, scoped, depth + 1);
            }
          } else if (entry.isFile()) await consume(name);
        }
      } catch { complete = false; notices.push("A source directory could not be scanned safely."); }
    }
    await walk(root, "", [], 0);
  }
  // No claims of a current snapshot if files changed during enumeration/hashing.
  if (!await validateMissingSources(root, missing, deadline)) complete = false;
  for (const [name, expected] of validations) {
    signal?.throwIfAborted();
    if (Date.now() >= deadline) { complete = false; break; }
    try { if (identity(await lstat(path.join(root, name))) !== expected) complete = false; }
    catch { complete = false; }
  }
  signal?.throwIfAborted();
  if ((await readSourceExtensions()).signature !== extensions.signature) {
    complete = false;
    notices.push("Source extension settings changed during scanning; retry to use the current classification.");
  }
  if (!complete) notices.push("Native scan incomplete (I/O, concurrent edit or scan limit); previous snapshot retained.");
  if (skipped) notices.push(`Excluded ${skipped} unsupported, linked, binary or oversized source files.`);
  return { files, notices: [...new Set(notices)].slice(0, 10), complete, updatedFiles, scannedFiles: files.size };
}
