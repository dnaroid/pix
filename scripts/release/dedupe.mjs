import { lstat, readdir, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { bytes, inside, ownDigest, packages } from "./payload-files.mjs";

function dependencyNames(manifest) {
  return [...new Set(Object.keys({ ...manifest.dependencies, ...manifest.optionalDependencies, ...manifest.peerDependencies }))].sort();
}

function resolveDependency(nodes, boundary, from, name) {
  if (nodes.get(from)?.manifest.name === name && nodes.get(from)?.manifest.exports) return from;
  for (let directory = from; inside(boundary, directory); directory = dirname(directory)) {
    const candidate = join(directory, "node_modules", ...name.split("/"));
    if (nodes.has(candidate)) return candidate;
    if (directory === boundary) break;
  }
  return undefined;
}

/** Compare whole dependency graphs, including optional/peer edges and shrinkwrapped nested packages.
 * A repeated pair closes a cycle, not a shortcut based on package name/version alone.
 */
export function equivalentGraph(nodes, left, right, seen = new Set()) {
  if (left === right) return true;
  if (!left || !right) return false;
  const a = nodes.get(left), b = nodes.get(right);
  if (!a || !b || a.digest !== b.digest || a.edges.size !== b.edges.size) return false;
  const pair = JSON.stringify([left, right]);
  if (seen.has(pair)) return true;
  seen.add(pair);
  for (const [key, dependency] of a.edges) {
    if (!b.edges.has(key) || !equivalentGraph(nodes, dependency, b.edges.get(key), seen)) return false;
  }
  return true;
}

export function rewriteShim(text, before, after) {
  const unixBefore = before.split(sep).join("/");
  const unixAfter = after.split(sep).join("/");
  return text.replaceAll(unixBefore, unixAfter).replaceAll(unixBefore.replaceAll("/", "\\"), unixAfter.replaceAll("/", "\\"));
}

async function rewireBins(binDirectory, replacements) {
  let entries;
  try { entries = await readdir(binDirectory); } catch (error) { if (error.code === "ENOENT") return; throw error; }
  for (const name of entries) {
    const path = join(binDirectory, name);
    const stat = await lstat(path);
    if (stat.isSymbolicLink()) {
      const destination = resolve(binDirectory, await readlink(path));
      const replacement = replacements.find(({ from }) => inside(from, destination));
      if (replacement) {
        const target = join(replacement.to, relative(replacement.from, destination));
        await rm(path);
        await symlink(relative(binDirectory, target), path, "file");
      }
    } else if (stat.isFile()) {
      // npm's Windows CMD, PowerShell and shell shims use paths relative to .bin.
      const original = await readFile(path, "utf8");
      let text = original;
      for (const { from, to } of replacements) {
        text = rewriteShim(text, `${relative(binDirectory, from)}${sep}`, `${relative(binDirectory, to)}${sep}`);
      }
      if (text !== original) await writeFile(path, text);
    }
  }
}

function populateEdges(nodes, boundary) {
  for (const node of nodes.values()) {
    node.edges = new Map();
    for (const name of dependencyNames(node.manifest)) {
      node.edges.set(`dependency:${name}`, resolveDependency(nodes, boundary, node.path, name));
    }
  }
  for (const nested of nodes.values()) {
    const modules = dirname(nested.path).split(sep).at(-1).startsWith("@")
      ? dirname(dirname(nested.path)) : dirname(nested.path);
    const owner = dirname(modules);
    const parent = nodes.get(owner);
    if (parent) parent.edges.set(`nested:${relative(owner, nested.path).split(sep).join("/")}`, nested.path);
  }
}

function fallback(nodes, boundary, path, name) {
  // Begin at the enclosing install site, not at the package being removed.
  // This is exactly the first candidate Node will inspect after removal.
  const modules = dirname(path).split(sep).at(-1).startsWith("@") ? dirname(dirname(path)) : dirname(path);
  for (let directory = dirname(modules); inside(boundary, directory); directory = dirname(directory)) {
    const candidate = join(directory, "node_modules", ...name.split("/"));
    if (candidate !== path && nodes.has(candidate)) return candidate;
    if (directory === boundary) break;
  }
  return undefined;
}

function installedName(path) {
  const parent = dirname(path);
  return parent.split(sep).at(-1).startsWith("@")
    ? `${parent.split(sep).at(-1)}/${path.split(sep).at(-1)}` : path.split(sep).at(-1);
}

/** Deduplicate nested packages and Desktop's top-level ACP packages by their first
 * real Node ancestor fallback. Recompute resolution after each deletion: a graph
 * proved against a now-removed/shadowed target must never authorize another removal.
 */
export async function dedupePackages(app, { withDesktop = false, dryRun = false } = {}) {
  app = resolve(app);
  const acp = join(app, "acp");
  const rootPackages = await packages(app);
  const acpPackages = withDesktop ? await packages(acp) : [];
  const nodes = new Map();
  for (const pkg of [...rootPackages, ...acpPackages]) {
    nodes.set(pkg.path, { ...pkg, digest: await ownDigest(pkg.path), edges: new Map() });
  }
  populateEdges(nodes, app);
  // Deepest-first avoids counting descendants twice; every accepted removal
  // refreshes graph edges and rewires shims before touching the filesystem.
  const candidates = [...nodes.values()].filter(({ path }) =>
    path.includes(`${sep}node_modules${sep}`) &&
    (path.slice(app.length).split(`${sep}node_modules${sep}`).length > 2 ||
      (withDesktop && inside(join(acp, "node_modules"), path))),
  ).sort((a, b) => b.path.split(`${sep}node_modules${sep}`).length - a.path.split(`${sep}node_modules${sep}`).length || a.path.localeCompare(b.path));
  const replacements = [];
  const binDirectories = [];
  if (!dryRun) for (const bin of new Set([join(app, "node_modules/.bin"), ...(withDesktop ? [join(acp, "node_modules/.bin")] : []),
    ...nodes.keys().map((path) => join(path, "node_modules/.bin"))])) {
    try { if ((await readdir(bin)).length) binDirectories.push(bin); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  // Revisit ancestors after descendant removal; stop only at a fixed point so
  // a second preparation run cannot remove a target left behind by this run.
  for (let changed = true; changed && !dryRun;) {
    changed = false;
    for (const pkg of candidates) {
      if (!nodes.has(pkg.path)) continue;
      const target = fallback(nodes, app, pkg.path, installedName(pkg.path));
      if (!target || !equivalentGraph(nodes, pkg.path, target)) continue;
      const replacement = { from: pkg.path, to: target, bytes: await bytes(pkg.path) };
      replacements.push(replacement);
      // Includes shims repointed during an earlier iteration to this same target.
      for (const bin of binDirectories) await rewireBins(bin, [replacement]);
      await rm(pkg.path, { recursive: true, force: true });
      for (const path of nodes.keys()) if (inside(pkg.path, path)) nodes.delete(path);
      populateEdges(nodes, app);
      changed = true;
    }
  }
  if (dryRun) {
    // Initial candidates only; do not pretend later graph recomputations have
    // occurred in a read-only estimate.
    for (const pkg of candidates) {
      const target = fallback(nodes, app, pkg.path, installedName(pkg.path));
      if (target && equivalentGraph(nodes, pkg.path, target)) replacements.push({ from: pkg.path, to: target, bytes: await bytes(pkg.path) });
    }
  }
  return replacements.map(({ from, to, bytes }) => ({ from: relative(app, from), to: relative(app, to), bytes }));
}

export async function dedupeAcp(app) { return dedupePackages(app, { withDesktop: true }); }
