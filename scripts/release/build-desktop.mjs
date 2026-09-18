import { copyFile, cp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { hostTarget, nodeVersion, npm, outputPaths, readJson, root, targetInfo, version } from "./common.mjs";
import { smokeDesktop } from "./smoke-desktop.mjs";
import { checkArchive, auditPayload } from "./size-budget.mjs";

export async function buildDesktop(name = hostTarget()) {
  const target = targetInfo(name);
  const { work, desktopPayload: payload, assets } = outputPaths(name);
  const manifest = readJson(join(payload, "release.json"));
  if (manifest.variant !== "desktop" || manifest.version !== version() || manifest.target !== name || manifest.node.version !== nodeVersion()) {
    throw new Error("Prepared runtime is stale. Run npm run release:build first.");
  }
  await auditPayload(payload, target, "desktop");
  const resources = join(root, "desktop/src-tauri/resources/pix-runtime");
  await rm(resources, { recursive: true, force: true, maxRetries: 5 });
  await mkdir(resources, { recursive: true });
  await cp(payload, resources, { recursive: true, verbatimSymlinks: true });
  const env = { ...process.env };
  // The DMG bundler checks CI separately from the CLI flag to skip Finder customization.
  env.CI = "true";
  for (const key of Object.keys(env)) if ((key.startsWith("APPLE_") || key.startsWith("TAURI_")) && !env[key]) delete env[key];
  if (process.platform === "darwin") env.APPLE_SIGNING_IDENTITY ||= "-";
  const configArgs = ["--config", "src-tauri/tauri.release.conf.json"];
  if (process.platform === "win32" && process.env.PIX_WINDOWS_CERTIFICATE_THUMBPRINT) {
    const signing = join(work, "windows-signing.json");
    await writeFile(signing, JSON.stringify({ bundle: { windows: {
      certificateThumbprint: process.env.PIX_WINDOWS_CERTIFICATE_THUMBPRINT,
      digestAlgorithm: "sha256", timestampUrl: "http://timestamp.digicert.com", tsp: true,
    } } }));
    configArgs.push("--config", signing);
  }
  // Tauri invokes build:web; the orchestrator has already built Pix/ACP and installed target dependencies.
  const bundleRoot = join(root, "desktop/src-tauri/target", target.triple, "release/bundle");
  await rm(bundleRoot, { recursive: true, force: true, maxRetries: 5 });
  npm(["exec", "--", "tauri", "build", "--ci", "--target", target.triple,
    "--features", "bundled-runtime", "--bundles", target.bundles, ...configArgs, "--", "--locked"], { cwd: join(root, "desktop"), env });
  const formats = process.platform === "darwin" ? [["dmg", ".dmg"]]
    : process.platform === "win32" ? [["nsis", ".exe"], ["msi", ".msi"]]
      : [["appimage", ".AppImage"], ["deb", ".deb"]];
  for (const [directory, extension] of formats) {
    const files = (await readdir(join(bundleRoot, directory))).filter((file) => file.endsWith(extension));
    if (files.length !== 1) throw new Error(`Expected one ${extension} installer, found ${files.length}`);
    const destination = join(assets, `pix-desktop-${version()}-${name}${extension === ".exe" ? "-setup" : ""}${extension}`);
    await copyFile(join(bundleRoot, directory, files[0]), destination);
    await checkArchive(destination, "desktop");
  }
  await smokeDesktop(name);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await buildDesktop(process.argv[2] ?? hostTarget());
