import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { checkPixUpdate, formatPixStartupUpdateDialog, getGlobalPiUpdateCommand, getPixSelfUpdateCommand, runPixUpdateCli, setPixUpdateTestDeps } from "../src/app/cli/update.js";
import { fetchLatestReleaseVersion, isReleaseInstall } from "../src/app/cli/release-update.js";

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
