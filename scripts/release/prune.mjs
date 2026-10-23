import { lstat, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { bytes, files, packages } from "./payload-files.mjs";

/** Only known, platform-specific package families are pruned. Never infer from arbitrary filenames. */
export function foreignPackage(name, target) {
  const pair = `${target.platform}-${target.arch}`;
  if (name.startsWith("@esbuild/")) return name !== `@esbuild/${pair}`;
  if (name.startsWith("@lydell/node-pty-")) return name !== `@lydell/node-pty-${pair}`;
  if (name.startsWith("@mariozechner/clipboard-")) {
    const supported = new Set([`@mariozechner/clipboard-${pair}`]);
    // These packages distinguish libc on Linux; universal is a valid macOS fallback.
    if (target.platform === "linux") supported.add(`@mariozechner/clipboard-${pair}-gnu`);
    if (target.platform === "win32") supported.add(`@mariozechner/clipboard-${pair}-msvc`);
    if (target.platform === "darwin") supported.add("@mariozechner/clipboard-darwin-universal");
    return !supported.has(name);
  }
  return false;
}

/** Clean only compiler outputs owned by this repository, before the release build. */
export async function cleanBuildOutputs(projectRoot, withDesktop = true) {
  for (const output of withDesktop ? ["dist", "acp/dist"] : ["dist"]) {
    await rm(join(projectRoot, output), { recursive: true, force: true, maxRetries: 5 });
  }
}

/** Prune only the extracted release copy; dev generations may still serve lazy imports. */
export async function pruneSuiteRuntime(app) {
  const runtime = join(app, "external/pi-tools-suite/build/runtime");
  const manifest = JSON.parse(await readFile(join(runtime, "manifest.json"), "utf8"));
  if (manifest.version !== 1 || !Array.isArray(manifest.outputs) || manifest.outputs.length === 0
    || !manifest.outputs.includes(manifest.entry)
    || !manifest.outputs.every((path) => typeof path === "string" && /^build\/runtime\/[^/\\]+\.mts$/.test(path))) {
    throw new Error("Invalid suite runtime manifest in release staging");
  }
  const keep = new Set(["manifest.json", ...manifest.outputs.map((path) => path.slice("build/runtime/".length))]);
  for (const name of await readdir(runtime)) {
    if (!keep.has(name)) await rm(join(runtime, name), { recursive: true, force: true });
  }
}

export async function pruneDependencies(app, target) {
  const removed = [];
  const installed = await packages(app);
  // An incomplete platform installation must fail, not silently lose every esbuild binary.
  for (const pkg of installed.filter((pkg) => pkg.manifest.name === "esbuild")) {
    const expected = `@esbuild/${target.platform}-${target.arch}`;
    if (!installed.some((candidate) => candidate.manifest.name === expected && candidate.manifest.version === pkg.manifest.version)) {
      throw new Error(`Missing ${expected}@${pkg.manifest.version} for ${pkg.path}`);
    }
  }
  for (const pkg of installed) {
    try { await lstat(pkg.path); } catch (error) { if (error.code === "ENOENT") continue; throw error; }
    if (foreignPackage(pkg.manifest.name ?? "", target)) {
      const size = await bytes(pkg.path);
      await rm(pkg.path, { recursive: true, force: true });
      removed.push({ package: pkg.manifest.name, bytes: size });
    } else if (pkg.manifest.name === "@earendil-works/pi-tui") {
      const prebuilds = join(pkg.path, "native/darwin/prebuilds");
      let entries;
      try { entries = await readdir(prebuilds); } catch (error) { if (error.code === "ENOENT") continue; throw error; }
      for (const entry of entries) {
        if (!/^darwin-(arm64|x64)$/u.test(entry) || entry === `${target.platform}-${target.arch}`) continue;
        const path = join(prebuilds, entry);
        const size = await bytes(path);
        await rm(path, { recursive: true, force: true });
        removed.push({ package: `${pkg.manifest.name}/native/${entry}`, bytes: size });
      }
    }
  }
  let sourceMapBytes = 0;
  // Preserve declarations, runtime TypeScript, assets, notices and licenses. Only debugging maps go.
  for await (const { path, stat } of files(app)) {
    if (stat.isFile() && /\.(?:[cm]?js|d\.[cm]?ts)\.map$/u.test(path)) {
      sourceMapBytes += stat.size;
      await rm(path);
    }
  }
  return { removed, sourceMapBytes };
}
