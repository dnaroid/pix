import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, symlink, link, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_SEARCH_SOURCES as SOURCE_DEFAULTS, readSourcePolicy, writeSourcePolicy, withSourcePolicy, requireSourceEnabled } from "../src/project-search/source-policy.mjs";
import { searchProject } from "../src/project-search/engine.js";
import { searchNative, indexNative } from "../src/project-search/native-engine.mjs";
import { runSourceIndex } from "../src/project-search/index-runner.js";
import projectSearchExtension from "../src/project-search/index.js";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { removeDirsWithRetry } from "./support/fs-retry.js";

const roots: string[] = [];
const originalHome = process.env.HOME;
let home: string | undefined;
afterEach(async () => {
  if (originalHome === undefined) delete process.env.HOME; else process.env.HOME = originalHome;
  home = undefined;
  await removeDirsWithRetry(roots);
});
async function fixture() {
  const base = fileURLToPath(new URL("../../../.pi/artifacts/source-policy-tests/", import.meta.url));
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(join(base, "run-")); roots.push(root);
  if (!home) { home = join(root, "home"); await mkdir(home); process.env.HOME = home; }
  await mkdir(join(root, ".git"));
  return root;
}
const signal = () => new AbortController().signal;

test("ACP and suite share identical policy/locking implementation apart from import extensions", async () => {
  for (const [suite, acp] of [["source-policy.mjs", "source-policy.js"], ["source-policy.d.mts", "source-policy.d.ts"],
    ["source-policy-lock.mjs", "source-policy-lock.js"], ["source-policy-lock.d.mts", "source-policy-lock.d.ts"],
    ["settings-policy.mjs", "settings-policy.js"]]) {
    expect((await readFile(new URL(`../src/project-search/${suite}`, import.meta.url), "utf8")).replaceAll('.mjs"', '.js"'))
      .toBe(await readFile(new URL(`../../../acp/src/search/${acp}`, import.meta.url), "utf8"));
  }
});

test("missing policy defaults only Settings/Code without creating storage; project selections are isolated", async () => {
  const a = await fixture(), b = await fixture();
  expect((await readSourcePolicy(a)).enabled).toEqual(SOURCE_DEFAULTS);
  expect(existsSync(join(a, ".pi"))).toBe(false);
  await writeSourcePolicy(a, "tasks", true);
  expect((await readSourcePolicy(a)).enabled.tasks).toBe(true);
  expect((await readSourcePolicy(b)).enabled.tasks).toBe(false);
  for (const source of ["settings", "code", "tasks"] as const) await writeSourcePolicy(a, source, false);
  expect(Object.values((await readSourcePolicy(a)).enabled).some(Boolean)).toBe(false);
  expect((await readSourcePolicy(b)).enabled.settings).toBe(false);
  expect((await readSourcePolicy(b)).enabled.code).toBe(true);
  expect(existsSync(join(b, ".pi"))).toBe(false);
});

test("malformed, symlinked, hardlinked, oversized policies fail closed, not back to enabled defaults", async () => {
  const root = await fixture(); await mkdir(join(root, ".pi"));
  const file = join(root, ".pi/search-sources.json"), target = join(root, "target.json");
  for (const text of ["invalid", "{}", JSON.stringify({ version: 2, enabled: SOURCE_DEFAULTS }), " ".repeat(9000)]) {
    await writeFile(file, text);
    const policy = await readSourcePolicy(root);
    expect(policy.error).toBeTruthy(); expect(Object.values(policy.enabled).some(Boolean)).toBe(false);
  }
  await rm(file); await writeFile(target, JSON.stringify({ version: 1, enabled: SOURCE_DEFAULTS }));
  await symlink(target, file);
  expect((await readSourcePolicy(root)).error).toBeTruthy();
  await expect(writeSourcePolicy(root, "tasks", true)).rejects.toThrow();
  await rm(file); await link(target, file);
  expect((await readSourcePolicy(root)).error).toBeTruthy();
  expect(await readFile(target, "utf8")).toContain('"tasks":false');
});

test("disabled history sources skip all dispatch and manual indexing before source scans/providers", async () => {
  const root = await fixture(); let calls = 0;
  const result = await searchProject(root, { query: "needle", sources: ["sessions", "tasks", "commits"], indexMode: "hybrid" }, {
    listSessions: async () => { calls++; return []; }, git: async () => { calls++; return ""; },
    semantic: { loadConfig: async () => { calls++; return undefined; } },
  });
  expect(result.hits).toEqual([]); expect(result.sources).toEqual([]); expect(calls).toBe(0);
  await expect(runSourceIndex(root, "sessions", signal(), { sessions: async () => { calls++; return []; } })).rejects.toThrow("disabled");
  expect(calls).toBe(0); expect(existsSync(join(root, ".pi/search"))).toBe(false);
});

test("native knowledge defaults off, retains its cache when disabled, and reuses it after re-enable", async () => {
  const root = await fixture(); await writeFile(join(root, "README.md"), "UniquePolicyNeedle");
  const query = { query: "UniquePolicyNeedle", sources: ["knowledge"], mode: "lexical" };
  expect((await searchNative(root, query)).hits).toEqual([]);
  expect(existsSync(join(root, ".pi/search/knowledge.sqlite"))).toBe(false);
  expect((await indexNative(root, { operation: "index", source: "knowledge" })).complete).toBe(false);
  await writeSourcePolicy(root, "knowledge", true);
  expect((await searchNative(root, query)).hits).toHaveLength(1);
  const cache = join(root, ".pi/search/knowledge.sqlite"), before = await readFile(cache);
  await writeSourcePolicy(root, "knowledge", false);
  expect((await searchNative(root, query)).hits).toEqual([]);
  expect(await readFile(cache)).toEqual(before);
  await writeSourcePolicy(root, "knowledge", true);
  expect((await searchNative(root, query)).hits).toHaveLength(1);
});

test("policy changes reject stale completion immediately, without waiting for the watcher tick", async () => {
  const root = await fixture();
  await expect(withSourcePolicy(root, signal(), async () => {
    await writeSourcePolicy(root, "code", false); return "stale";
  })).rejects.toThrow("selection changed");
});

test("global Settings disable/re-enable fences another project's work and ignores its legacy flag", async () => {
  const a = await fixture(), b = await fixture();
  await mkdir(join(a, ".pi"));
  await writeFile(join(a, ".pi/search-sources.json"), JSON.stringify({ version: 1, enabled: { ...SOURCE_DEFAULTS, settings: false } }));
  expect((await readSourcePolicy(a)).enabled.settings).toBe(true);
  const before = await readSourcePolicy(a);
  let sends = 0;
  await expect(withSourcePolicy(a, signal(), async owned => {
    await writeSourcePolicy(b, "settings", false);
    expect((await readSourcePolicy(a)).enabled.settings).toBe(false);
    await writeSourcePolicy(b, "settings", true);
    await requireSourceEnabled(a, "settings", owned);
    sends++;
  })).rejects.toThrow("selection changed");
  expect(sends).toBe(0);
  expect((await readSourcePolicy(a)).revision).not.toBe(before.revision);
  expect(existsSync(join(b, ".pi"))).toBe(false);
});

test("unsafe or malformed global Settings policy fails closed without mutating its target", async () => {
  const root = await fixture();
  await writeSourcePolicy(root, "settings", true);
  const file = join(home!, ".config/pi/search/settings-enabled.json"), target = join(root, "target");
  for (const text of ["invalid", '{"version":1,"enabled":true,"extra":1}', " ".repeat(1025)]) {
    await writeFile(file, text);
    expect((await readSourcePolicy(root)).error).toBeTruthy();
    await expect(writeSourcePolicy(root, "settings", false)).rejects.toThrow();
    expect(await readFile(file, "utf8")).toBe(text);
  }
  await rm(file); await writeFile(target, '{"version":1,"enabled":true}');
  for (const makeLink of [symlink, link]) {
    await makeLink(target, file);
    expect((await readSourcePolicy(root)).error).toBeTruthy();
    await expect(writeSourcePolicy(root, "settings", false)).rejects.toThrow();
    await rm(file);
  }
  expect(await readFile(target, "utf8")).toBe('{"version":1,"enabled":true}');
});

test("policy revisions distinguish disable/re-enable from an unchanged enabled map", async () => {
  const root = await fixture();
  const before = await readSourcePolicy(root);
  await writeSourcePolicy(root, "code", false);
  const written = await writeSourcePolicy(root, "code", true);
  const after = await readSourcePolicy(root);
  expect(after.enabled).toEqual(before.enabled);
  expect(after.revision).not.toBe(before.revision);
  expect(written.revision).toBe(after.revision);
  expect((await readSourcePolicy(root)).revision).toBe(after.revision);
});

test("disable/re-enable fences paid-work checkpoints as well as returned results", async () => {
  const root = await fixture(); let sends = 0;
  await expect(withSourcePolicy(root, signal(), async owned => {
    await writeSourcePolicy(root, "code", false);
    await writeSourcePolicy(root, "code", true);
    await requireSourceEnabled(root, "code", owned);
    sends++;
    return "stale";
  })).rejects.toThrow("selection changed");
  expect(sends).toBe(0);
});

test("tool metadata refresh advertises enabled sources only; all-off schema has no source choices", async () => {
  const root = await fixture();
  const events = new Map<string, Function[]>(); const tools: any[] = [];
  projectSearchExtension({ registerTool: (tool: any) => tools.push(tool), registerCommand: () => {},
    on: (name: string, callback: Function) => events.set(name, [...events.get(name) ?? [], callback]),
  } as unknown as ExtensionAPI);
  const metadataStart = events.get("session_start")!.at(-1)!;
  await metadataStart({}, { cwd: root });
  expect(tools.at(-1).parameters.properties.sources.items.enum).toEqual(["code"]);
  expect(tools.at(-1).description).not.toMatch(/Knowledge|Sessions|Tasks|commits/);
  await writeSourcePolicy(root, "sessions", true);
  await metadataStart({}, { cwd: root });
  const guidance = tools.at(-1).promptGuidelines.join("\n");
  expect(guidance).toContain("after one hour of inactivity, never while its agent runs");
  expect(guidance).toContain("manual indexing bypasses this delay");
  expect(guidance).toContain("Session queries rank cached vectors without embedding documents");
  await writeSourcePolicy(root, "sessions", false);
  await writeSourcePolicy(root, "code", false);
  await metadataStart({}, { cwd: root });
  expect(tools.at(-1).description).toContain("none");
  expect(tools.at(-1).parameters.properties.sources).toBeUndefined();
  await events.get("session_shutdown")!.at(-1)!({}, {});
});
