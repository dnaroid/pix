import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { npm, root } from "../common.mjs";

const suite = join(root, "external/pi-tools-suite");
const json = async (path) => JSON.parse(await readFile(path, "utf8"));

test("native search's ignore parser is a locked root production dependency", async () => {
  const manifest = await json(join(root, "package.json"));
  const suiteManifest = await json(join(suite, "package.json"));
  const lock = await json(join(root, "package-lock.json"));
  const version = suiteManifest.dependencies.ignore;
  assert.equal(manifest.dependencies.ignore, version);
  assert.equal(lock.packages[""].dependencies.ignore, version);
  assert.equal(lock.packages["node_modules/ignore"].version, version);
  assert.notEqual(lock.packages["node_modules/ignore"].dev, true);
});

test("global suite JSONC parsing is a locked root production dependency", async () => {
  const manifest = await json(join(root, "package.json"));
  const lock = await json(join(root, "package-lock.json"));
  assert.equal(manifest.dependencies["jsonc-parser"], "3.3.1");
  assert.equal(lock.packages[""].dependencies["jsonc-parser"], "3.3.1");
  assert.equal(lock.packages["node_modules/jsonc-parser"].version, "3.3.1");
  assert.notEqual(lock.packages["node_modules/jsonc-parser"].dev, true);
});

test("relocated native CLI uses only release-root dependencies without IDX or ACP", async (t) => {
  const packed = JSON.parse(npm(["pack", "--dry-run", "--ignore-scripts", "--json"], {
    stdio: ["ignore", "pipe", "pipe"], encoding: "utf8",
  }))[0];
  const packedPaths = new Set(packed.files.map((file) => file.path));
  const artifacts = join(root, ".pi/artifacts");
  await mkdir(artifacts, { recursive: true });
  const directory = await mkdtemp(join(artifacts, "native-release-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const app = join(directory, "app");
  const engine = join(app, "external/pi-tools-suite/src/project-search");
  const workspace = join(directory, "workspace");
  await mkdir(engine, { recursive: true });
  await mkdir(workspace);
  for (const name of ["cli", "engine", "scan", "store", "semantic", "vector-store", "embedding-provider", "source-config"]) {
    assert.ok(packedPaths.has(`external/pi-tools-suite/src/project-search/native-${name}.mjs`));
    await cp(join(suite, `src/project-search/native-${name}.mjs`), join(engine, `native-${name}.mjs`));
  }
  // Release preparation installs root dependencies, not the suite's node_modules.
  const dependency = join(app, "node_modules/ignore");
  await cp(join(root, "node_modules/ignore"), dependency, { recursive: true });
  await cp(join(root, "node_modules/jsonc-parser"), join(app, "node_modules/jsonc-parser"), { recursive: true });
  assert.ok(packedPaths.has("external/pi-tools-suite/src/project-search/source-extension-settings.mjs"));
  await cp(join(suite, "src/project-search/source-extension-settings.mjs"), join(engine, "source-extension-settings.mjs"));
  for (const name of ["source-work"]) {
    assert.ok(packedPaths.has(`external/pi-tools-suite/src/project-search/${name}.mjs`));
    await cp(join(suite, `src/project-search/${name}.mjs`), join(engine, `${name}.mjs`));
  }
  const entry = join(engine, "native-cli.mjs");
  assert.equal(dirname(createRequire(entry).resolve("ignore/package.json")), dependency);
  await writeFile(join(workspace, "owner.ts"), "export const NativeReleaseProbe = 42;\n");
  await writeFile(join(workspace, ".gitignore"), "ignored.ts\n");
  await writeFile(join(workspace, "ignored.ts"), "export const NativeReleaseProbe = 0;\n");
  const run = spawnSync(process.execPath, [entry, workspace], {
    input: JSON.stringify({ query: "NativeReleaseProbe", sources: ["code"], mode: "lexical" }),
    encoding: "utf8", timeout: 15_000,
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, HOME: directory },
  });
  assert.equal(run.status, 0, run.stderr || run.error?.message);
  const result = JSON.parse(run.stdout);
  assert.equal(result.status.stale, false, run.stdout);
  assert.equal(result.status.complete, true, run.stdout);
  assert.deepEqual(result.hits.map((hit) => [hit.path, hit.startLine]), [["owner.ts", 1]]);
});
