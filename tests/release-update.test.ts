import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { checkPixUpdate, formatPixStartupUpdateDialog, getGlobalPiUpdateCommand, getPixSelfUpdateCommand, runPixUpdateCli, setPixUpdateTestDeps } from "../src/app/cli/update.js";
import { fetchLatestReleaseVersion, isReleaseInstall } from "../src/app/cli/release-update.js";
import { parseSha256Sums, portableReleaseAssets, portableTuiAssetName, safeZipEntryPath } from "../src/app/cli/portable-update.js";
import { swapPortableInstall } from "../src/app/cli/portable-update-helper.js";

test("portable marker blocks all npm mutations even under node_modules and with --force", async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), "pix-portable-update-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const packageRoot = join(temporary, "node_modules", "pi-ui-extend");
  await mkdir(packageRoot, { recursive: true });
  await writeFile(join(packageRoot, "package.json"), JSON.stringify({ name: "pi-ui-extend", version: "1.2.3" }));
  // A damaged marker must fail closed, not fall back to package-manager installation detection.
  await writeFile(join(packageRoot, ".pix-portable.json"), "invalid-json");
  assert.equal(isReleaseInstall(packageRoot), true);
  assert.equal(getPixSelfUpdateCommand("pi-ui-extend", "1.2.4", packageRoot), undefined);
  assert.equal(getGlobalPiUpdateCommand("0.85.1", packageRoot), undefined);
  const result = { status: "newer" as const, packageRoot, packageName: "pi-ui-extend", currentVersion: "1.2.3", latestVersion: "1.2.4" };
  let commands = 0;
  setPixUpdateTestDeps({ checkPixUpdate: async () => result, runCommand: async () => { commands++; } });
  t.after(() => setPixUpdateTestDeps());
  assert.equal(await runPixUpdateCli(["--check"]), 0);
  assert.equal(await runPixUpdateCli(["--force"]), 1);
  assert.equal(await runPixUpdateCli([]), 1);
  assert.equal(commands, 0);
  const text = formatPixStartupUpdateDialog(result);
  assert.match(text, /github\.com\/dnaroid\/pix\/releases/u);
  assert.doesNotMatch(text, /run.*npm install|synchronizes the global/u);
});

test("portable update uses GitHub stable release metadata instead of npm", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "pix-release-update-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, "package.json"), JSON.stringify({ name: "pi-ui-extend", version: "1.2.3" }));
  await writeFile(join(directory, ".pix-portable.json"), "{}");
  const oldFetch = globalThis.fetch;
  const previous = Object.fromEntries(["PI_OFFLINE", "PI_SKIP_VERSION_CHECK", "PIX_SKIP_VERSION_CHECK"].map((key) => [key, process.env[key]]));
  for (const key of Object.keys(previous)) delete process.env[key];
  t.after(() => {
    globalThis.fetch = oldFetch;
    for (const [key, value] of Object.entries(previous)) value === undefined ? delete process.env[key] : process.env[key] = value;
  });
  const calls: string[] = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return new Response(JSON.stringify({ tag_name: "v1.2.4", draft: false, prerelease: false }));
  };
  const result = await checkPixUpdate({ packageRoot: directory });
  assert.equal(result.status, "newer");
  assert.deepEqual(calls, ["https://api.github.com/repos/dnaroid/pix/releases/latest"]);
  globalThis.fetch = async () => new Response(JSON.stringify({ tag_name: "v1.2.5", draft: true }));
  assert.equal(await fetchLatestReleaseVersion("pix", "1.2.3", 1000), undefined);
  globalThis.fetch = async () => new Response(JSON.stringify({ tag_name: "v1.2.5-beta.1", prerelease: true }));
  assert.equal(await fetchLatestReleaseVersion("pix", "1.2.3", 1000), undefined);
  globalThis.fetch = async () => new Response("", { status: 403 });
  await assert.rejects(fetchLatestReleaseVersion("pix", "1.2.3", 1000), /GitHub Releases returned 403/u);
});

test("portable TUI update schedules verified replacement while Desktop refuses CLI mutation", async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), "pix-release-apply-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const packageRoot = join(temporary, "app");
  await mkdir(packageRoot, { recursive: true });
  await writeFile(join(packageRoot, "package.json"), JSON.stringify({ name: "pi-ui-extend", version: "2.0.0" }));
  await writeFile(join(packageRoot, ".pix-portable.json"), JSON.stringify({ format: 2, version: "2.0.0", target: "macos-arm64", variant: "tui" }));
  const result = { status: "newer" as const, packageRoot, packageName: "pi-ui-extend", currentVersion: "2.0.0", latestVersion: "2.0.1" };
  let scheduled = 0;
  setPixUpdateTestDeps({
    checkPixUpdate: async () => result,
    schedulePortableTuiUpdate: async () => { scheduled++; return { version: "2.0.1", assetName: "pix-tui-2.0.1-macos-arm64.tar.gz" }; },
  });
  t.after(() => setPixUpdateTestDeps());
  assert.equal(await runPixUpdateCli(["--check"]), 0);
  assert.equal(scheduled, 0);
  assert.equal(await runPixUpdateCli([]), 0);
  assert.equal(scheduled, 1);

  await writeFile(join(packageRoot, ".pix-portable.json"), JSON.stringify({ format: 2, version: "2.0.0", target: "macos-arm64", variant: "desktop" }));
  assert.equal(await runPixUpdateCli([]), 1);
  assert.equal(scheduled, 1);
});

test("portable release selection is exact and checksums reject ambiguity", () => {
  const release = {
    tag: "v2.0.1",
    version: "2.0.1",
    assets: [
      { name: "pix-tui-2.0.1-windows-x64.zip", url: "https://example.invalid/tui" },
      { name: "SHA256SUMS", url: "https://example.invalid/sums" },
    ],
  };
  assert.equal(portableTuiAssetName("2.0.1", "windows-x64"), "pix-tui-2.0.1-windows-x64.zip");
  assert.deepEqual(portableReleaseAssets(release, "windows-x64"), { archive: release.assets[0], checksums: release.assets[1] });
  const digest = "a".repeat(64);
  assert.equal(parseSha256Sums(`${digest}  pix-tui-2.0.1-windows-x64.zip\n`, release.assets[0]!.name), digest);
  assert.throws(() => parseSha256Sums(`${digest}  ${release.assets[0]!.name}\n${digest}  ${release.assets[0]!.name}\n`, release.assets[0]!.name), /ambiguous/u);
  assert.throws(() => portableReleaseAssets({ ...release, assets: [release.assets[0]!] }, "windows-x64"), /SHA256SUMS/u);
  assert.throws(() => portableTuiAssetName("2.0.1", "windows-arm64"), /Invalid release target/u);
});

test("portable ZIP paths cannot escape or use Windows path aliases", () => {
  const root = resolve("/tmp/pix-update-root");
  assert.equal(safeZipEntryPath(root, "pix/app/main.js"), join(root, "pix/app/main.js"));
  for (const name of ["../escape", "pix/../../escape", "/absolute", "C:/absolute", "pix\\escape", "pix/./escape"]) {
    assert.throws(() => safeZipEntryPath(root, name), /Unsafe ZIP entry/u, name);
  }
});

test("portable swap replaces one sibling tree and rolls back when staging is missing", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pix-swap-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const installRoot = join(root, "pix");
  const stagedRoot = join(root, ".pix.update");
  const backupRoot = join(root, ".pix.backup");
  const helperRoot = join(root, "helper");
  await mkdir(join(installRoot, "runtime"), { recursive: true });
  await mkdir(join(stagedRoot, "runtime"), { recursive: true });
  await writeFile(join(installRoot, "version.txt"), "old");
  await writeFile(join(stagedRoot, "version.txt"), "new");
  const swap = { parentPid: process.pid, installRoot, stagedRoot, backupRoot, helperRoot, nodeRelativePath: process.platform === "win32" ? "runtime/node.exe" : "runtime/node" };
  await swapPortableInstall(swap);
  assert.equal(await readFile(join(installRoot, "version.txt"), "utf8"), "new");

  await mkdir(stagedRoot, { recursive: true });
  await writeFile(join(stagedRoot, "version.txt"), "newer");
  await rm(stagedRoot, { recursive: true });
  await assert.rejects(swapPortableInstall(swap));
  assert.equal(await readFile(join(installRoot, "version.txt"), "utf8"), "new");
});
