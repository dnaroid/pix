import { chmod, copyFile, cp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { hostTarget, npm, outputPaths, readJson, root, run, targetInfo, version } from "./common.mjs";
import { installNode } from "./node-runtime.mjs";
import { cleanBuildOutputs, pruneDependencies } from "./prune.mjs";
import { dedupeAcp } from "./dedupe.mjs";
import { recordSize } from "./size-budget.mjs";

export async function prepare(name = hostTarget(), { withDesktop = true } = {}) {
  const target = targetInfo(name);
  const { work, payload, desktopPayload, assets } = outputPaths(name);
  run(process.execPath, [join(root, "scripts/release/sync-version.mjs"), "--check"]);
  await cleanBuildOutputs(root, withDesktop);
  npm(["run", "build:pix"]);
  if (withDesktop) npm(["run", "build:acp"]);
  await rm(work, { recursive: true, force: true, maxRetries: 5 });
  const app = join(payload, "app");
  await mkdir(app, { recursive: true });
  await mkdir(assets, { recursive: true });

  // Use the actual npm payload allowlist: never copy the checkout, HOME, secrets, or local node_modules.
  const packed = JSON.parse(npm(["pack", "--ignore-scripts", "--json", "--pack-destination", work], {
    stdio: ["ignore", "pipe", "inherit"], encoding: "utf8",
  }));
  const tarball = join(work, packed[0].filename);
  run("tar", ["-xzf", tarball, "-C", app, "--strip-components=1"]);
  await copyFile(join(root, "package-lock.json"), join(app, "package-lock.json"));
  npm(["ci", "--omit=dev", "--include=optional", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: app });
  const trimmed = await pruneDependencies(app, target);
  const node = await installNode(payload, target);
  await finalize(payload, name, node, "tui", { pix: trimmed });
  await recordSize(payload, target, "tui");

  if (withDesktop) {
    await cp(payload, desktopPayload, { recursive: true, verbatimSymlinks: true });
    const desktopApp = join(desktopPayload, "app");
    const acp = join(desktopApp, "acp");
    await mkdir(acp, { recursive: true });
    for (const file of ["package.json", "package-lock.json"]) await copyFile(join(root, "acp", file), join(acp, file));
    await cp(join(root, "acp/dist"), join(acp, "dist"), { recursive: true });
    npm(["ci", "--omit=dev", "--include=optional", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: acp });
    const acpTrimmed = await pruneDependencies(acp, target);
    const shared = await dedupeAcp(desktopApp);
    await finalize(desktopPayload, name, node, "desktop", { pix: trimmed, acp: acpTrimmed, shared });
    await recordSize(desktopPayload, target, "desktop");
  }
  await rm(tarball);
  console.log(`Prepared ${payload}${withDesktop ? ` and ${desktopPayload}` : ""}`);
  return payload;
}

async function finalize(payload, name, node, variant, optimizations) {
  const app = join(payload, "app");
  const manifest = { format: 2, channel: "github-release", version: version(), target: name, variant, node };
  await writeFile(join(payload, "release.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(join(app, ".pix-portable.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  for (const file of ["pix", "pix.cmd"]) {
    await copyFile(join(root, "scripts/release/launchers", file), join(payload, file));
    await chmod(join(payload, file), 0o755);
  }
  await copyFile(join(root, "scripts/release/probe.mjs"), join(payload, "verify.mjs"));
  await copyFile(join(root, "scripts/release/bootstrap.mjs"), join(payload, "bootstrap.mjs"));
  await writeFile(join(payload, "README.txt"), `Pix ${version()} (${name})\n\nRun ./pix (macOS/Linux) or pix.cmd (Windows) from a terminal.\nKeep the whole directory together. No system Node.js or npm is needed.\nGit, shells, and tools for your projects are separate prerequisites.\nSettings and sessions are stored in your user profile, not here.\nUpdates: https://github.com/dnaroid/pix/releases/latest\nReplace the complete directory after closing Pix; do not mix versions.\nDependency licenses are retained in app/node_modules and app/acp/node_modules; Node license: runtime/LICENSE.\n`);
  await writeFile(join(payload, "DEPENDENCIES.json"), `${JSON.stringify(await dependencyInventory(app), null, 2)}\n`);
  await writeFile(join(payload, "OPTIMIZATIONS.json"), `${JSON.stringify(optimizations, null, 2)}\n`);
}

async function dependencyInventory(app) {
  const packages = [];
  async function visit(directory, relative = "") {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink() || entry.name === ".bin") continue;
      const path = join(directory, entry.name);
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await visit(path, name);
      else if (entry.name === "package.json" && relative.includes("node_modules")) {
        const pkg = readJson(path);
        if (pkg.name && pkg.version) packages.push({ path: name, name: pkg.name, version: pkg.version, license: pkg.license ?? "SEE PACKAGE LICENSE" });
      }
    }
  }
  await visit(app);
  return packages.sort((a, b) => a.path.localeCompare(b.path));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await prepare(process.argv[2] ?? hostTarget());
}
