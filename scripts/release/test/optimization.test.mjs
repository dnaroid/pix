import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, readlink, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { targets } from "../common.mjs";
import { cleanBuildOutputs, foreignPackage, pruneDependencies } from "../prune.mjs";
import { dedupeAcp, equivalentGraph } from "../dedupe.mjs";
import { assertBudget, auditPayload, budgets } from "../size-budget.mjs";

async function fixture(t) {
  const path = await mkdtemp(join(tmpdir(), "pix size fixture "));
  t.after(() => rm(path, { recursive: true, force: true, maxRetries: 5 }));
  return path;
}

async function file(path, content) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
}

async function install(root, name, version = "1.0.0", manifest = {}, source = `module.exports = ${JSON.stringify(version)};`) {
  const path = join(root, "node_modules", name);
  await file(join(path, "package.json"), JSON.stringify({ name, version, main: "index.cjs", ...manifest }));
  await file(join(path, "index.cjs"), source);
  return path;
}

test("platform pruning keeps each target, macOS universal and Linux glibc; leaves unknown families alone", () => {
  for (const target of Object.values(targets)) {
    const own = `${target.platform}-${target.arch}`;
    assert.equal(foreignPackage(`@esbuild/${own}`, target), false);
    assert.equal(foreignPackage(`@lydell/node-pty-${own}`, target), false);
    assert.equal(foreignPackage("application-linux-docs", target), false);
    assert.equal(foreignPackage("@esbuild/android-arm64", target), true);
    assert.equal(foreignPackage("@mariozechner/clipboard-linux-x64-musl", target), true);
  }
  assert.equal(foreignPackage("@mariozechner/clipboard-linux-x64-gnu", targets["linux-x64"]), false);
  assert.equal(foreignPackage("@mariozechner/clipboard-win32-x64-msvc", targets["windows-x64"]), false);
  assert.equal(foreignPackage("@mariozechner/clipboard-darwin-universal", targets["macos-arm64"]), false);
});

test("pruning removes foreign nested binaries and debug maps, not runtime TS, declarations, WASM or licenses", async (t) => {
  const root = await fixture(t);
  const sdk = await install(root, "sdk");
  await install(sdk, "esbuild");
  const own = await install(sdk, "@esbuild/darwin-arm64");
  const foreign = await install(sdk, "@esbuild/win32-x64");
  for (const name of ["index.js.map", "index.d.ts.map", "runtime.ts", "index.d.ts", "LICENSE", "module.wasm", "data.map"]) {
    await file(join(sdk, name), "fixture");
  }
  const result = await pruneDependencies(root, targets["macos-arm64"]);
  assert.equal(existsSync(foreign), false);
  assert.equal(existsSync(own), true);
  assert.equal(result.removed.length, 1);
  assert.equal(result.sourceMapBytes, 14);
  for (const name of ["runtime.ts", "index.d.ts", "LICENSE", "module.wasm", "data.map"]) assert.ok(existsSync(join(sdk, name)), name);
  assert.equal(existsSync(join(sdk, "index.js.map")), false);
  assert.deepEqual(await pruneDependencies(root, targets["macos-arm64"]), { removed: [], sourceMapBytes: 0 });
});

test("missing target binary fails before pruning unrelated packages", async (t) => {
  const root = await fixture(t);
  await install(root, "esbuild");
  const foreign = await install(root, "@esbuild/win32-x64");
  await assert.rejects(pruneDependencies(root, targets["macos-arm64"]), /Missing @esbuild\/darwin-arm64/u);
  assert.ok(existsSync(foreign));
});

test("release build cleanup removes stale JS and Vosk from outputs only", async (t) => {
  const root = await fixture(t);
  for (const name of ["dist/old.js", "dist/models/vosk/old-model", "acp/dist/old.js", "src/main.ts", "models/vosk/user-model"]) {
    await file(join(root, name), "preserve unless compiler output");
  }
  await cleanBuildOutputs(root);
  assert.equal(existsSync(join(root, "dist")), false);
  assert.equal(existsSync(join(root, "acp/dist")), false);
  assert.ok(existsSync(join(root, "models/vosk/user-model")));
  assert.ok(existsSync(join(root, "src/main.ts")));
});

test("ACP equivalent graphs share parent packages; CJS resolution and bin shims survive relocation", async (t) => {
  const root = await fixture(t), app = join(root, "app"), acp = join(app, "acp");
  for (const directory of [app, acp]) {
    await install(directory, "dep");
    const sdk = await install(directory, "@test/sdk", "1.0.0", { dependencies: { dep: "1.0.0" }, bin: { sdk: "index.cjs" } }, "module.exports = require('dep');");
    await install(sdk, "@nested/hidden");
  }
  const bin = join(acp, "node_modules/.bin");
  await file(join(bin, "sdk.cmd"), '@"%dp0%\\..\\@test\\sdk\\index.cjs" %*\r\n');
  await file(join(bin, "sdk.ps1"), '& "$basedir/../@test/sdk/index.cjs" $args\n');
  if (process.platform !== "win32") await symlink("../@test/sdk/index.cjs", join(bin, "sdk"));
  const changes = await dedupeAcp(app);
  assert.equal(changes.length, 2);
  assert.equal(existsSync(join(acp, "node_modules/@test/sdk")), false);
  assert.equal(createRequire(join(acp, "package.json"))("@test/sdk"), "1.0.0");
  assert.match(await readFile(join(bin, "sdk.cmd"), "utf8"), /\.\.\\\.\.\\\.\.\\node_modules\\@test\\sdk/u);
  assert.match(await readFile(join(bin, "sdk.ps1"), "utf8"), /\.\.\/\.\.\/\.\.\/node_modules\/@test\/sdk/u);
  if (process.platform !== "win32") assert.equal(resolve(bin, await readlink(join(bin, "sdk"))), join(app, "node_modules/@test/sdk/index.cjs"));
  assert.deepEqual(await dedupeAcp(app), []);
  const moved = join(root, "relocated app с пробелами");
  await rename(app, moved);
  assert.equal(createRequire(join(moved, "acp/package.json"))("@test/sdk"), "1.0.0");
  if (process.platform !== "win32") {
    assert.equal(await realpath(join(moved, "acp/node_modules/.bin/sdk")), await realpath(join(moved, "node_modules/@test/sdk/index.cjs")));
  }
});

test("same package version is not enough when transitive versions or contents differ", async (t) => {
  const root = await fixture(t), acp = join(root, "acp");
  for (const directory of [root, acp]) {
    await install(directory, "consumer", "1.0.0", { dependencies: { dep: "*" } });
    await install(directory, "same-version");
  }
  await install(root, "dep", "1.0.0");
  await install(acp, "dep", "2.0.0");
  await file(join(acp, "node_modules/same-version/index.cjs"), "module.exports = 'different';");
  assert.deepEqual(await dedupeAcp(root), []);
});

test("dedupe preserves optional/peer context and nested package differences", async (t) => {
  const root = await fixture(t), acp = join(root, "acp");
  for (const directory of [root, acp]) {
    await install(directory, "optional-consumer", "1.0.0", { optionalDependencies: { addon: "*" } });
    await install(directory, "peer-consumer", "1.0.0", { peerDependencies: { addon: "*" } });
    const sdk = await install(directory, "sdk");
    await install(sdk, "@nested/private", directory === root ? "1.0.0" : "2.0.0");
  }
  await install(acp, "addon");
  assert.deepEqual(await dedupeAcp(root), []);
});

test("graph comparison handles cycles without accepting a differing branch", () => {
  const node = (digest, edges) => ({ digest, edges: new Map(edges) });
  const nodes = new Map([
    ["a", node("same", [["cycle", "b"], ["tail", "x"]])], ["b", node("same", [["cycle", "a"]])],
    ["c", node("same", [["cycle", "d"], ["tail", "y"]])], ["d", node("same", [["cycle", "c"]])],
    ["x", node("one", [])], ["y", node("two", [])],
  ]);
  assert.equal(equivalentGraph(nodes, "a", "c"), false);
  nodes.get("y").digest = "one";
  assert.equal(equivalentGraph(nodes, "a", "c"), true);
});

test("size limits are strict and the content audit rejects TUI ACP and stale models", async (t) => {
  for (const variant of Object.keys(budgets)) for (const kind of ["unpacked", "archive"]) {
    assert.doesNotThrow(() => assertBudget(budgets[variant][kind], variant, kind));
    assert.throws(() => assertBudget(budgets[variant][kind] + 1, variant, kind), /exceeds size budget/u);
  }
  assert.throws(() => assertBudget(0, "unknown", "archive"), /Invalid/u);
  const root = await fixture(t);
  await file(join(root, "app/main.js"), "hello");
  assert.equal((await auditPayload(root, targets["macos-arm64"], "tui")).fileBytes, 5);
  await file(join(root, "app/acp/dist/main.js"), "forbidden");
  await assert.rejects(auditPayload(root, targets["macos-arm64"], "tui"), /TUI must not include/u);
  await rm(join(root, "app/acp"), { recursive: true });
  await file(join(root, "app/dist/models/vosk/model"), "forbidden");
  await assert.rejects(auditPayload(root, targets["macos-arm64"], "tui"), /Legacy Vosk/u);
});

test("executable mode differences prevent dependency sharing", { skip: process.platform === "win32" }, async (t) => {
  const root = await fixture(t), acp = join(root, "acp");
  const left = await install(root, "executable");
  const right = await install(acp, "executable");
  await chmod(join(left, "index.cjs"), 0o644);
  await chmod(join(right, "index.cjs"), 0o755);
  assert.deepEqual(await dedupeAcp(root), []);
});

test("payload audits reject outside and dangling links without following directory links", { skip: process.platform === "win32" }, async (t) => {
  const root = await fixture(t), payload = join(root, "payload");
  await file(join(root, "outside.js"), "outside");
  await file(join(payload, "app/main.js"), "inside");
  const link = join(payload, "app/link.js");
  await symlink("../../outside.js", link);
  await assert.rejects(auditPayload(payload, targets["macos-arm64"], "tui"), /Non-portable link/u);
  await rm(link);
  await symlink("missing.js", link);
  await assert.rejects(auditPayload(payload, targets["macos-arm64"], "tui"), { code: "ENOENT" });
  await rm(link);
  await symlink("../..", join(payload, "app/node_modules"));
  await assert.rejects(auditPayload(payload, targets["macos-arm64"], "tui"), /Non-portable link/u);
});
