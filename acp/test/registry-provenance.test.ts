import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { parse } from "jsonc-parser";
import { readProvenance, writeProvenance } from "../src/registry/provenance.js";
import { REGISTRY_SCHEMA_URL } from "../src/registry/model.js";
import type { RegistryContext } from "../src/registry/context.js";

async function fixture(t: TestContext) {
  const artifacts = new URL("../../.pi/artifacts/", import.meta.url);
  await fs.mkdir(artifacts, { recursive: true });
  const cwd = await fs.mkdtemp(fileURLToPath(new URL("registry-provenance-", artifacts)));
  t.after(() => fs.rm(cwd, { recursive: true, force: true }));
  await fs.mkdir(join(cwd, ".pi"));
  return {
    ctx: { cwd } as RegistryContext,
    canonical: join(cwd, ".pi/registry.jsonc"),
    legacy: join(cwd, ".pi/registry.json"),
  };
}

test("legacy provenance is read without side effects and migrated on the next write", async (t) => {
  const { ctx, canonical, legacy } = await fixture(t);
  const source = '{ // keep\n "version":1, "resources":{}, "future":true, }';
  await fs.writeFile(legacy, source);
  const provenance = await readProvenance(ctx);
  assert.equal(await fs.readFile(legacy, "utf8"), source);
  await assert.rejects(fs.stat(canonical), { code: "ENOENT" });
  provenance.resources["agent:demo"] = { type: "agent", name: "demo", remote: "remote", branch: "main", revision: "rev", hash: "hash" };
  await writeProvenance(ctx, provenance);
  const next = await fs.readFile(canonical, "utf8");
  assert.ok(next.includes("// keep"));
  assert.equal(parse(next).$schema, REGISTRY_SCHEMA_URL);
  assert.equal(parse(next).future, true);
  assert.deepEqual(await readProvenance(ctx), provenance);
  await assert.rejects(fs.stat(legacy), { code: "ENOENT" });
  assert.deepEqual((await fs.readdir(join(ctx.cwd, ".pi"))).sort(), ["registry.jsonc"]);
});

test("canonical JSONC wins and preserves custom schema, comments and unrelated fields", async (t) => {
  const { ctx, canonical, legacy } = await fixture(t);
  await fs.writeFile(legacy, "broken legacy");
  const source = '{ // comment\n "$schema":"./custom.json", "version":1, "resources":{}, "projectResources":{}, "future": {"value":42}, }\n';
  await fs.writeFile(canonical, source);
  const provenance = await readProvenance(ctx);
  await writeProvenance(ctx, provenance);
  const next = await fs.readFile(canonical, "utf8");
  assert.ok(next.includes("// comment"));
  assert.equal(parse(next).$schema, "./custom.json");
  assert.equal(parse(next).future.value, 42);
  assert.equal(await fs.readFile(legacy, "utf8"), "broken legacy");
});

test("malformed canonical state never falls back to legacy or gets overwritten", async (t) => {
  const { ctx, canonical, legacy } = await fixture(t);
  await fs.writeFile(legacy, '{"version":1,"resources":{}}');
  for (const source of ["{", "[]", '{"version":2,"resources":{}}', '{"version":1,"resources":[]}']) {
    await fs.writeFile(canonical, source);
    await assert.rejects(readProvenance(ctx), /Invalid Registry provenance/);
    await assert.rejects(writeProvenance(ctx, { version: 1, resources: {}, projectResources: {} }), /Invalid Registry provenance/);
    assert.equal(await fs.readFile(canonical, "utf8"), source);
  }
});

test("missing provenance starts in JSONC with schema metadata", async (t) => {
  const { ctx, canonical } = await fixture(t);
  const provenance = await readProvenance(ctx);
  assert.deepEqual(provenance, { version: 1, resources: {}, projectResources: {} });
  await writeProvenance(ctx, provenance);
  assert.deepEqual(parse(await fs.readFile(canonical, "utf8")), { $schema: REGISTRY_SCHEMA_URL, ...provenance });
});

test("migration refuses to replace canonical state created by another writer", async (t) => {
  const { ctx, canonical, legacy } = await fixture(t);
  const source = '{"version":1,"resources":{}}';
  await fs.writeFile(legacy, source);
  const provenance = await readProvenance(ctx);
  const link = fs.link;
  const concurrent = '{"version":1,"resources":{},"future":"concurrent"}';
  t.mock.method(fs, "link", async (...args: Parameters<typeof fs.link>) => {
    await fs.writeFile(canonical, concurrent);
    return link(...args);
  });
  await assert.rejects(writeProvenance(ctx, provenance), { code: "EEXIST" });
  assert.equal(await fs.readFile(canonical, "utf8"), concurrent);
  assert.equal(await fs.readFile(legacy, "utf8"), source);
  assert.deepEqual((await fs.readdir(join(ctx.cwd, ".pi"))).sort(), ["registry.json", "registry.jsonc"]);
});
