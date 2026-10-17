import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
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
  for (const name of ["cli", "engine", "scan", "store", "semantic", "vector-store", "embedding-provider", "source-config", "reranker", "reranker-context"]) {
    assert.ok(packedPaths.has(`external/pi-tools-suite/src/project-search/native-${name}.mjs`));
    await cp(join(suite, `src/project-search/native-${name}.mjs`), join(engine, `native-${name}.mjs`));
  }
  // Release preparation installs root dependencies, not the suite's node_modules.
  const dependency = join(app, "node_modules/ignore");
  await cp(join(root, "node_modules/ignore"), dependency, { recursive: true });
  await cp(join(root, "node_modules/jsonc-parser"), join(app, "node_modules/jsonc-parser"), { recursive: true });
  assert.ok(packedPaths.has("external/pi-tools-suite/src/project-search/source-extension-settings.mjs"));
  await cp(join(suite, "src/project-search/source-extension-settings.mjs"), join(engine, "source-extension-settings.mjs"));
  for (const name of ["source-work", "source-policy", "source-policy-lock", "settings-policy",
    "federation-reranker", "snapshot-probe", "session-discovery", "session-record", "session-text",
    "session-revisions", "session-index-revision", "task-snapshot", "repository-snapshot",
    "source-coverage", "commit-stamp"]) {
    assert.ok(packedPaths.has(`external/pi-tools-suite/src/project-search/${name}.mjs`));
    await cp(join(suite, `src/project-search/${name}.mjs`), join(engine, `${name}.mjs`));
  }
  // Copy the remaining runtime import closure so new helper modules cannot
  // silently diverge from the package file list. Type-only JSDoc imports are
  // not runtime edges.
  const pending = (await readdir(engine)).filter((name) => name.endsWith(".mjs"));
  const copied = new Set(pending);
  while (pending.length) {
    const source = await readFile(join(engine, pending.pop()), "utf8");
    for (const match of source.matchAll(/^\s*(?:import|export)(?!\s+type\b)[^;]*?\sfrom\s*["'](\.\/[^"'/]+\.mjs)["']|\bimport\(\s*["'](\.\/[^"'/]+\.mjs)["']\s*\)/gm)) {
      const name = (match[1] ?? match[2]).slice(2);
      if (copied.has(name)) continue;
      assert.ok(packedPaths.has(`external/pi-tools-suite/src/project-search/${name}`), `${name} must be packed`);
      await cp(join(suite, "src/project-search", name), join(engine, name));
      copied.add(name);
      pending.push(name);
    }
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
  const native = input => spawnSync(process.execPath, [entry, workspace], {
    input: JSON.stringify(input), encoding: "utf8", timeout: 15_000,
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, HOME: directory },
  });
  const prepared = native({ operation: "rerank-prepare", sources: ["sessions", "tasks", "commits", "code", "knowledge"] });
  assert.equal(prepared.status, 0, prepared.stderr || prepared.error?.message);
  assert.deepEqual(JSON.parse(prepared.stdout), {}); // no global opt-in in relocated HOME
  const candidates = Array.from({ length: 100 }, (_, id) => ({ kind: "code", id: String(id), title: "文".repeat(512), snippet: "文".repeat(4096), content: "文".repeat(7500) }));
  const large = native({ operation: "rerank", query: "unicode", candidates });
  assert.equal(large.status, 0, large.stderr || large.error?.message);
  assert.deepEqual(JSON.parse(large.stdout), { notices: [] });
  const oversizedOther = native({ query: "NativeReleaseProbe", sources: ["code"], mode: "lexical", padding: "x".repeat(16384) });
  assert.equal(oversizedOther.status, 0); // failures use the JSON protocol, not the exit status
  assert.equal(JSON.parse(oversizedOther.stdout).status.complete, false);
  assert.ok(JSON.parse(oversizedOther.stdout).notices.length);
});
