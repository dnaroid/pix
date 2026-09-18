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

/** Remove only equivalent top-level ACP duplicates. Do not rewrite lockfile versions or use directory links. */
export async function dedupeAcp(app) {
  app = resolve(app);
  const acp = join(app, "acp");
  const rootPackages = await packages(app);
  const acpPackages = await packages(acp);
  const nodes = new Map();
  for (const pkg of [...rootPackages, ...acpPackages]) {
    nodes.set(pkg.path, { ...pkg, digest: await ownDigest(pkg.path), edges: new Map() });
  }
  for (const node of nodes.values()) {
    for (const name of dependencyNames(node.manifest)) {
      node.edges.set(`dependency:${name}`, resolveDependency(nodes, app, node.path, name));
    }
    for (const nested of nodes.values()) {
      const parent = dirname(dirname(nested.path));
      const scopedParent = dirname(parent);
      if (parent === node.path || (dirname(nested.path).split(sep).at(-1).startsWith("@") && scopedParent === node.path)) {
        node.edges.set(`nested:${relative(node.path, nested.path).split(sep).join("/")}`, nested.path);
      }
    }
  }
  const replacements = [];
  for (const pkg of acpPackages) {
    const local = relative(join(acp, "node_modules"), pkg.path);
    if (local.split(sep).includes("node_modules")) continue;
    const parent = join(app, "node_modules", local);
    if (equivalentGraph(nodes, pkg.path, parent)) {
      replacements.push({ from: pkg.path, to: parent, bytes: await bytes(pkg.path) });
    }
  }
  // Rewire shims while both targets exist. Actual package loading then uses normal parent resolution.
  await rewireBins(join(acp, "node_modules/.bin"), replacements);
  for (const { from } of replacements) await rm(from, { recursive: true, force: true });
  return replacements.map(({ from, to, bytes }) => ({ from: relative(app, from), to: relative(app, to), bytes }));
}
