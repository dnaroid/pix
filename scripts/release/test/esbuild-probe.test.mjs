import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { verifyEsbuildInventory } from "../esbuild-probe.mjs";

async function fixture(t) {
  const app = await mkdtemp(join(tmpdir(), "pix esbuild probe "));
  t.after(() => rm(app, { recursive: true, force: true, maxRetries: 5 }));
  return app;
}

async function install(app, path, source) {
  const directory = join(app, path);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "package.json"), JSON.stringify({ name: "esbuild", main: "index.cjs" }));
  await writeFile(join(directory, "index.cjs"), source);
  return { name: "esbuild", path: `${path}/package.json` };
}

test("runtime using jiti without production esbuild passes the esbuild probe", async (t) => {
  const app = await fixture(t);
  assert.equal(verifyEsbuildInventory(app, [{ name: "jiti", path: "node_modules/jiti/package.json" }]), 0);
  assert.equal(verifyEsbuildInventory(app, []), 0);
});

test("every retained esbuild instance transforms TypeScript and stops exactly once", async (t) => {
  const app = await fixture(t);
  const source = `const assert = require('node:assert/strict');
    module.exports = { transforms: 0, stops: 0,
      transformSync(text, options) {
        assert.equal(text, 'const value: number = 42');
        assert.deepEqual(options, { loader: 'ts' });
        this.transforms++; return { code: 'const value = 42;' };
      }, stop() { this.stops++; } };`;
  const entries = await Promise.all([
    install(app, "node_modules/esbuild", source),
    install(app, "acp/node_modules/sdk/node_modules/esbuild", source),
  ]);
  assert.equal(verifyEsbuildInventory(app, [...entries, entries[0]]), 2);
  const require = createRequire(join(app, "package.json"));
  for (const entry of entries) {
    const esbuild = require(join(app, entry.path, ".."));
    assert.equal(esbuild.transforms, 1);
    assert.equal(esbuild.stops, 1);
  }
});

test("retained esbuild failures still fail smoke and stop the service", async (t) => {
  const app = await fixture(t);
  const entry = await install(app, "node_modules/esbuild", `module.exports = {
    stops: 0, transformSync() { throw new Error('missing native esbuild binary'); },
    stop() { this.stops++; } };`);
  assert.throws(() => verifyEsbuildInventory(app, [entry]), /missing native esbuild binary/u);
  const require = createRequire(join(app, "package.json"));
  assert.equal(require(join(app, "node_modules/esbuild")).stops, 1);
  assert.throws(() => verifyEsbuildInventory(app, [{ name: "esbuild", path: "node_modules/missing/package.json" }]), /Cannot find module/u);
});

test("esbuild inventory paths cannot escape the payload", async (t) => {
  const app = await fixture(t);
  for (const path of ["../outside/package.json", join(app, "..", "outside", "package.json")]) {
    assert.throws(() => verifyEsbuildInventory(app, [{ name: "esbuild", path }]), /Unsafe dependency inventory path/u);
  }
});
