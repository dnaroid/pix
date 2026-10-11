import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, readFile, symlink } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseSourceExtensions, sourceKind } from "../src/project-search/native-source-config.mjs";
import { searchNative, indexNative } from "../src/project-search/native-engine.mjs";
import { openStore, snapshot } from "../src/project-search/native-store.mjs";
import { scanProject } from "../src/project-search/native-scan.mjs";
import { removeDirsWithRetry } from "./support/fs-retry.js";

const artifacts = fileURLToPath(new URL("../../../.pi/artifacts/", import.meta.url));
const originalHome = process.env.HOME;
const roots: string[] = [];
afterEach(async () => {
  if (originalHome === undefined) delete process.env.HOME; else process.env.HOME = originalHome;
  await removeDirsWithRetry(roots);
});

async function fixture() {
  await mkdir(artifacts, { recursive: true });
  const root = await mkdtemp(path.join(artifacts, "source-extensions-"));
  roots.push(root);
  const home = path.join(root, "home"), workspace = path.join(root, "workspace");
  const config = path.join(home, ".config/pi/pi-tools-suite.jsonc");
  await mkdir(path.dirname(config), { recursive: true });
  await mkdir(workspace);
  process.env.HOME = home;
  const save = (search: object) => writeFile(config, JSON.stringify({ search }));
  const put = (name: string, content = "ExtensionNeedle\n") => writeFile(path.join(workspace, name), content);
  const query = () => searchNative(workspace, { query: "ExtensionNeedle", sources: ["code", "knowledge"], mode: "lexical", limit: 100 });
  return { workspace, config, save, put, query };
}

test("normalizes authoritative lists without hidden additions and ignores unrelated settings", () => {
  const a = parseSourceExtensions('{"search":{"codeExtensions":[".ZIG","zig"],"knowledgeExtensions":[".ORG"]}}');
  const b = parseSourceExtensions('{/*comment*/"search":{"codeExtensions":["zig"],"knowledgeExtensions":["org"],},"todo":{}}');
  expect(a.signature).toBe(b.signature);
  expect(sourceKind("a.ZiG", a)).toBe("code");
  expect(sourceKind("a.ORG", a)).toBe("knowledge");
  for (const name of ["a.gd", "a.ts", "Dockerfile", "Makefile", "CMakeLists.txt", "a.md", "a.txt", "a.unknown"]) {
    expect(sourceKind(name, a)).toBeUndefined();
  }
  const defaults = parseSourceExtensions("{}");
  expect(sourceKind("a.gd", defaults)).toBe("code");
  expect(sourceKind("a.md", defaults)).toBe("knowledge");
  const reassigned = parseSourceExtensions('{"search":{"codeExtensions":["md"],"knowledgeExtensions":[]}}');
  expect(sourceKind("a.md", reassigned)).toBe("code");
});

test("rejects malformed lists, unsafe suffixes and conflicts with either defaults or custom lists", () => {
  for (const codeExtensions of [null, "gd", [42], [""], ["."], ["*.x"], ["../x"], ["x/y"], ["x\\y"], ["a.b"], [" x"], ["x\n"], ["a".repeat(33)], Array(129).fill("x")]) {
    expect(() => parseSourceExtensions(JSON.stringify({ search: { codeExtensions } }))).toThrow("search.codeExtensions");
  }
  for (const search of [{ codeExtensions: ["MD"] }, { knowledgeExtensions: [".TS"] }, { codeExtensions: [".ABC"], knowledgeExtensions: ["abc"] }]) {
    expect(() => parseSourceExtensions(JSON.stringify({ search }))).toThrow("overlap");
  }
  for (const text of ["{", "null", '{"search":[]}']) expect(() => parseSourceExtensions(text)).toThrow("invalid suite JSONC");
});

test("add, reorder, reclassify unchanged bytes and remove custom formats on the next lexical scan", async () => {
  const f = await fixture();
  await f.put("a.custom"); await f.put("b.ts"); await f.put("readme.md");
  expect((await f.query()).hits).toHaveLength(2);
  await f.save({ codeExtensions: ["custom", "zig"] });
  const added = await f.query();
  expect(added.status.complete).toBe(true);
  expect(added.hits.find(hit => hit.path === "a.custom")?.kind).toBe("code");
  expect(added.hits.some(hit => hit.path === "b.ts")).toBe(false);
  expect(added.status.updatedFiles).toBe(1);
  await f.save({ codeExtensions: [".ZIG", ".CUSTOM", "custom"] });
  expect((await f.query()).status.updatedFiles).toBe(0);
  await f.save({ knowledgeExtensions: ["custom"] });
  const moved = await f.query();
  expect(moved.hits.find(hit => hit.path === "a.custom")?.kind).toBe("knowledge");
  expect(moved.status.updatedFiles).toBe(2);
  await f.save({ codeExtensions: [], knowledgeExtensions: [] });
  const removed = await f.query();
  expect(removed.hits).toEqual([]);
  expect(removed.status.updatedFiles).toBe(0);
  expect(await readFile(path.join(f.workspace, ".pi/search/file-vectors.sqlite")).catch(() => undefined)).toBeUndefined();
});

test("custom suffixes do not bypass ignores, generated directories, binary or linked-file exclusions", async () => {
  const f = await fixture();
  await f.save({ codeExtensions: ["custom"] });
  await f.put("visible.custom"); await f.put("hidden.custom"); await f.put("binary.custom", "ExtensionNeedle\0");
  await f.put(".gitignore", "hidden.custom\n");
  await symlink(path.join(f.workspace, "visible.custom"), path.join(f.workspace, "link.custom"));
  await mkdir(path.join(f.workspace, ".godot"));
  await f.put(".godot/generated.custom");
  await mkdir(path.join(f.workspace, ".pi"));
  await f.put(".pi/pi-tools-suite.jsonc", '{"search":{"knowledgeExtensions":["custom"]}}');
  expect((await f.query()).hits.map(hit => [hit.path, hit.kind])).toEqual([["visible.custom", "code"]]);
});

test("invalid config reports actionable errors without publishing over the previous cache", async () => {
  const f = await fixture();
  await f.put("a.ts");
  const previous = await f.query();
  await f.save({ codeExtensions: ["md"] });
  const result = await f.query();
  expect(result.status.complete).toBe(false);
  expect(result.notices.join(" ")).toContain("overlap");
  const index = await indexNative(f.workspace, { operation: "index", source: "code" });
  expect(index.message).toContain("overlap");
  const store = await openStore(f.workspace);
  try { expect(snapshot(store).generation).toBe(previous.status.generation); }
  finally { store.close(); }
});

test("a configuration change during scanning cannot publish mixed classification", async () => {
  const f = await fixture();
  await f.save({ codeExtensions: ["custom"] }); await f.put("a.custom");
  await f.query();
  const store = await openStore(f.workspace);
  try {
    const previous = snapshot(store);
    const get = previous.files.get.bind(previous.files);
    previous.files.get = (name: string) => {
      writeFileSync(f.config, '{"search":{"knowledgeExtensions":["custom"]}}');
      return get(name);
    };
    const scan = await scanProject(f.workspace, previous);
    expect(scan.complete).toBe(false);
    expect(scan.notices.join(" ")).toContain("settings changed");
    expect(snapshot(store).generation).toBe(previous.generation);
  } finally { store.close(); }
});
