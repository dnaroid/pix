import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { Value } from "typebox/value";
import { RegistryProvenanceSchema } from "../src/schemas/registry-schema.js";

test("registry schema supports legacy optional fields and current provenance", () => {
  const origin = { remote: "remote", branch: "main", revision: "rev", hash: "hash" };
  for (const config of [
    { version: 1, resources: {} },
    { version: 1, resources: { "skill:demo": { type: "skill", name: "demo", ...origin } } },
    { version: 1, resources: { "agent:demo": { type: "agent", name: "demo", ...origin, publicationScope: "project", projectKey: "pix" } }, projectResources: { workspace: { artifact: "workspace", projectKey: "pix", ...origin } } },
  ]) assert.equal(Value.Check(RegistryProvenanceSchema, config), true);
  for (const config of [
    { version: 2, resources: {} }, { version: 1, resources: [] },
    { version: 1, resources: { "skill:demo": { type: "skill", name: "demo" } } },
    { version: 1, resources: {}, projectResources: { tasks: { artifact: "bad", projectKey: "pix", ...origin } } },
  ]) assert.equal(Value.Check(RegistryProvenanceSchema, config), false);
});

test("generated registry schema is exported and matches its source and writer URL", () => {
  const generated = JSON.parse(readFileSync(new URL("../schemas/registry.json", import.meta.url), "utf8"));
  assert.deepEqual(generated, JSON.parse(JSON.stringify(RegistryProvenanceSchema)));
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(pkg.exports["./schemas/registry.json"], "./schemas/registry.json");
  assert.ok(readFileSync(new URL("../acp/src/registry/model.ts", import.meta.url), "utf8").includes(generated.$id));
});
