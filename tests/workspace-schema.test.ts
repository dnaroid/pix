import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { Value } from "typebox/value";
import { WorkspaceConfigSchema } from "../src/schemas/workspace-schema.js";

test("workspace schema models current settings and allows forward-compatible fields", () => {
  for (const config of [
    {},
    { search: {} },
    { search: { sources: { tasks: true, code: false }, revision: "nonce", future: 1 } },
    { color: "#abc", icon: ".pi/project-icon.svg" },
    { color: "#AABBCCDD", launchCommands: [{ id: "dev", name: "Dev", command: "npm run dev" }] },
    { projectExplorer: { expandedDirectories: ["src", ".pi"], future: true } },
    { usagePanel: { collapsedSections: ["activity", "future"] }, future: true },
    { usagePanel: { providerOrder: ["zhipu", "openai", "future"] } },
  ]) assert.equal(Value.Check(WorkspaceConfigSchema, config), true);
});

test("workspace schema rejects invalid known fields", () => {
  for (const config of [
    { search: { sources: { settings: true } } },
    { search: { sources: { code: "yes" } } },
    { search: { revision: 3 } },
    { color: "blue" }, { color: "#12345" }, { icon: "../icon.png" },
    { launchCommands: [{ id: "dev", name: " ", command: "echo ok" }] },
    { launchCommands: [{ name: "Dev", command: "echo ok" }] },
    { projectExplorer: { expandedDirectories: [1] } },
    { projectExplorer: { expandedDirectories: ["src", "src"] } },
    { projectExplorer: { expandedDirectories: Array.from({ length: 257 }, (_, i) => `dir-${i}`) } },
    { usagePanel: { collapsedSections: [1] } }, { $schema: 42 },
    { usagePanel: { providerOrder: "openai" } }, { usagePanel: { providerOrder: [1] } },
  ]) assert.equal(Value.Check(WorkspaceConfigSchema, config), false, JSON.stringify(config));
});

test("generated workspace schema and package export match the source", () => {
  const schema = JSON.parse(readFileSync(new URL("../schemas/workspace.json", import.meta.url), "utf8"));
  assert.deepEqual(schema, JSON.parse(JSON.stringify(WorkspaceConfigSchema)));
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(pkg.exports["./schemas/workspace.json"], "./schemas/workspace.json");
  const helper = readFileSync(new URL("../desktop/src/lib/workspace-config-schema.ts", import.meta.url), "utf8");
  assert.ok(helper.includes(schema.$id));
});
