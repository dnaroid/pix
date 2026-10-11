import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdir, mkdtemp, readFile, rm, writeFile, rename, symlink } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { searchNative } from "../src/project-search/native-engine.mjs";
import { openVectorStore } from "../src/project-search/native-vector-store.mjs";
import { embedRepository, repositoryEmbeddingSettings } from "../src/project-search/native-embedding-provider.mjs";

const roots: string[] = [];
const originalHome = process.env.HOME;
const settingsPath = (root: string) => join(root, "../.config/pi/pi-tools-suite.jsonc");
const artifacts = fileURLToPath(new URL("../../../.pi/artifacts/", import.meta.url));
const config = { embeddingProvider: "openrouter", embeddingModel: "fixture/code", knowledgeEmbeddingModel: "fixture/docs",
  vectorSize: 3, knowledgeEmbeddingQueryPrefix: "question: ", knowledgeEmbeddingDocumentPrefix: "passage: " };
async function put(root: string, name: string, value: string) {
  await mkdir(join(root, name, ".."), { recursive: true });
  await writeFile(join(root, name), value);
}
async function fixture(enabled = true) {
  await mkdir(artifacts, { recursive: true });
  const home = await mkdtemp(join(artifacts, "native-semantic-")); roots.push(home);
  process.env.HOME = home;
  const root = join(home, "project");
  await mkdir(join(root, ".pi/search"), { recursive: true });
  await put(root, "../.config/pi/pi-tools-suite.jsonc", JSON.stringify(enabled ? { revision: "fixture", search: { embedding: config } } : {}));
  return root;
}
const request = (extra = {}) => ({ query: "restore access after expiration", sources: ["code", "knowledge"], includeContent: true, ...extra });
function fakeProvider() {
  const calls: { inputs: string[]; model: string }[] = [];
  return { calls, key: async () => "fixture-only-key", embed: async (inputs: string[], cfg: any) => {
    calls.push({ inputs, model: cfg.model });
    return inputs.map(text => Array.from({ length: cfg.dimension }, (_, i) =>
      i === (/renewCredentials|restore access|Token rotation/.test(text) ? 0 : 1) ? 1 : 0));
  } };
}
afterEach(async () => { if (originalHome === undefined) delete process.env.HOME; else process.env.HOME = originalHome; for (const root of roots.splice(0)) await rm(root, { force: true, recursive: true }); });

describe("native semantic repository retrieval", () => {
  test("split Code and Knowledge share the original 128-document upload budget", async () => {
    const root = await fixture(), provider = fakeProvider();
    for (let i = 0; i < 130; i++) {
      await put(root, `code/item${i}.ts`, `export const token${i} = 'renewCredentials';`);
      await put(root, `docs/item${i}.md`, `# Token rotation ${i}\nUnique document ${i}`);
    }
    await searchNative(root, request(), provider);
    const documents = provider.calls.flatMap(call => call.inputs).filter(input => !input.endsWith(request().query));
    expect(documents).toHaveLength(128);
  });
  test("suite-owned provider configuration needs no IDX directory and never silently falls back", async () => {
    const root = await fixture(), provider = fakeProvider();
    await put(root, "../.config/pi/pi-tools-suite.jsonc", JSON.stringify({ enabled: true, search: { embedding: config } }));
    await put(root, "auth.ts", "renewCredentials");
    expect((await searchNative(root, request(), provider)).hits[0].path).toBe("auth.ts");
    provider.calls.length = 0;
    await put(root, ".indexer-cli/config.json", JSON.stringify(config));
    await put(root, "../.config/pi/pi-tools-suite.jsonc", JSON.stringify({ enabled: true }));
    expect(await repositoryEmbeddingSettings(root)).toBeUndefined();
    await put(root, "../.config/pi/pi-tools-suite.jsonc", JSON.stringify({ enabled: true, search: { embedding: null } }));
    expect(await repositoryEmbeddingSettings(root)).toBeUndefined();
    expect((await searchNative(root, request(), provider)).hits).toEqual([]);
    expect(provider.calls).toEqual([]);
  });

  test("off and lexical modes never invoke embeddings or create a vector cache", async () => {
    const root = await fixture(false), provider = fakeProvider();
    await put(root, "auth.ts", "export function renewCredentials() {}\n");
    expect((await searchNative(root, request(), provider)).hits).toEqual([]);
    await put(root, "../.config/pi/pi-tools-suite.jsonc", '{"enabled":true}');
    const local = await searchNative(root, request({ mode: "lexical", query: "renewCredentials" }), provider);
    expect(local.hits[0].path).toBe("auth.ts");
    expect(provider.calls).toEqual([]);
    const db = new Database(join(root, ".pi/search/code.sqlite"), { readonly: true });
    try { expect(db.query("SELECT name FROM sqlite_master WHERE name='vectors'").get()).toBeNull(); }
    finally { db.close(); }
  });

  test("project overrides and legacy top-level embedding never authorize uploads", async () => {
    const root = await fixture(false), provider = fakeProvider();
    await put(root, ".pi/search/semantic.json", JSON.stringify({ enabled: true, embedding: config }));
    await put(root, "auth.ts", "renewCredentials");
    expect(await repositoryEmbeddingSettings(root)).toBeUndefined();
    expect((await searchNative(root, request(), provider)).hits).toEqual([]);
    expect(provider.calls).toEqual([]);
    await put(root, "../.config/pi/pi-tools-suite.jsonc", JSON.stringify({ enabled: false, embedding: config }));
    expect(await repositoryEmbeddingSettings(root)).toBeUndefined();
    expect((await searchNative(root, request(), provider)).hits).toEqual([]);
    expect(provider.calls).toEqual([]);
  });

  test("finds no-token-overlap code/docs with saved per-domain models and exact references", async () => {
    const root = await fixture(), provider = fakeProvider();
    await put(root, "auth.ts", "export function renewCredentials() {}\n");
    await put(root, "docs.md", "# Token rotation\nrenewCredentials\n");
    await put(root, "other.ts", "export const unrelated = 1;\n");
    const before = await readFile(settingsPath(root));
    const result = await searchNative(root, request(), provider);
    expect(result.hits.map((hit: any) => hit.path).sort()).toEqual(["auth.ts", "docs.md"]);
    expect(result.status.mode).toBe("hybrid");
    expect(result.status.semantic).toMatchObject({ state: "ready", indexed: 3, total: 3 });
    expect(result.hits[0]).toMatchObject({ startLine: 1, endLine: 1, content: "export function renewCredentials() {}" });
    expect(provider.calls.map(call => call.model)).toContain("fixture/code");
    expect(provider.calls.map(call => call.model)).toContain("fixture/docs");
    expect(provider.calls.flatMap(call => call.inputs)).toContain("question: restore access after expiration");
    expect(provider.calls.flatMap(call => call.inputs).some(text => text.startsWith("passage: docs.md"))).toBe(true);
    expect(await readFile(settingsPath(root))).toEqual(before);
    provider.calls.length = 0;
    expect((await searchNative(root, request(), provider)).hits).toEqual(result.hits);
    expect(provider.calls).toEqual([]);
  });

  test("edits/deletions/renames invalidate current matches without erasing purchased vectors", async () => {
    const root = await fixture(), provider = fakeProvider();
    await put(root, "auth.ts", "renewCredentials");
    await searchNative(root, request(), provider);
    provider.calls.length = 0;
    await put(root, "auth.ts", "other unrelated text");
    expect((await searchNative(root, request(), provider)).hits).toEqual([]);
    expect(provider.calls.flatMap(call => call.inputs)).toEqual(["auth.ts\nauth.ts\nother unrelated text"]);
    await put(root, "auth.ts", "renewCredentials");
    await rename(join(root, "auth.ts"), join(root, "renamed.ts"));
    expect((await searchNative(root, request(), provider)).hits[0].path).toBe("renamed.ts");
    await rm(join(root, "renamed.ts"));
    expect((await searchNative(root, request(), provider)).hits).toEqual([]);
    const db = new Database(join(root, ".pi/search/code.sqlite"), { readonly: true });
    try { expect((db.query("SELECT count(*) AS n FROM vectors").get() as any).n).toBe(4); }
    finally { db.close(); }
  });

  test("scope/test filters also constrain uploaded chunks; hybrid preserves exact lexical hits", async () => {
    const root = await fixture(), provider = fakeProvider();
    await put(root, "src/auth.ts", "renewCredentials");
    await put(root, "src/auth.test.ts", "renewCredentials");
    await put(root, "private/docs.md", "Token rotation");
    const response = await searchNative(root, request({ sources: ["code"], pathPrefix: "src", excludeTests: true }), provider);
    expect(response.hits.map((hit: any) => hit.path)).toEqual(["src/auth.ts"]);
    expect(response.status.semantic.total).toBe(1);
    expect(provider.calls.flatMap(call => call.inputs).join(" ")).not.toContain("private");
    expect(provider.calls.flatMap(call => call.inputs).join(" ")).not.toContain("auth.test.ts");
    expect((await searchNative(root, request({ query: "renewCredentials", mode: "hybrid" }), provider)).hits.length).toBeGreaterThan(0);
  });

  test("bounded indexing progresses on later searches and reports partial coverage", async () => {
    const root = await fixture(), provider = fakeProvider();
    for (let n = 0; n < 130; n++) await put(root, `f${n}.ts`, "renewCredentials");
    const first = await searchNative(root, request(), provider);
    expect(first.status.complete).toBe(false);
    expect(first.status.semantic).toMatchObject({ state: "partial", indexed: 128, total: 130 });
    provider.calls.length = 0;
    const next = await searchNative(root, request(), provider);
    expect(next.status.semantic).toMatchObject({ state: "ready", indexed: 130, total: 130 });
    expect(provider.calls.flatMap(call => call.inputs)).toHaveLength(2);
  });

  test("model/dimension/prefix changes use isolated caches, never old incompatible vectors", async () => {
    const root = await fixture(), provider = fakeProvider();
    await put(root, "auth.ts", "renewCredentials");
    await searchNative(root, request(), provider);
    provider.calls.length = 0;
    await put(root, "../.config/pi/pi-tools-suite.jsonc", JSON.stringify({ enabled: true, search: { embedding: { ...config, embeddingModel: "fixture/new", vectorSize: 4 } } }));
    const response = await searchNative(root, request(), provider);
    expect(response.hits[0].path).toBe("auth.ts");
    expect(provider.calls).toHaveLength(2);
    expect(provider.calls.every(call => call.model === "fixture/new")).toBe(true);
  });

  test("lexical publication remains unlocked during HTTP and stale completions are discarded", async () => {
    const root = await fixture(), provider = fakeProvider();
    await put(root, "auth.ts", "renewCredentials");
    let enter!: () => void, finish!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; });
    const gate = new Promise<void>(resolve => { finish = resolve; });
    const pending = searchNative(root, request(), { ...provider, embed: async (inputs: string[], cfg: any) => {
      enter(); await gate; return provider.embed(inputs, cfg);
    } });
    await entered;
    await put(root, "auth.ts", "changedWhileEmbedding");
    const current = await searchNative(root, request({ mode: "lexical", query: "changedWhileEmbedding" }));
    expect(current.status.complete).toBe(true);
    expect(current.hits[0].content).toBe("changedWhileEmbedding");
    finish();
    const stale = await pending;
    expect(stale.status.semantic.state).toBe("unavailable");
    expect(stale.hits).toEqual([]);
    const db = new Database(join(root, ".pi/search/code.sqlite"), { readonly: true });
    try { expect((db.query("SELECT COUNT(*) AS n FROM vectors").get() as any).n).toBe(0); }
    finally { db.close(); }
  });

  test("removing configuration cancels in-flight provider work and rejects its vectors", async () => {
    const root = await fixture(), provider = fakeProvider();
    await put(root, "auth.ts", "renewCredentials");
    let enter!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; });
    let aborted = false;
    const pending = searchNative(root, request(), { ...provider, embed: async (_inputs: string[], _cfg: any, _key: any, signal: AbortSignal) => {
      enter();
      await new Promise((_, reject) => signal.addEventListener("abort", () => { aborted = true; reject(new Error("aborted")); }, { once: true }));
    } });
    await entered;
    await put(root, "../.config/pi/pi-tools-suite.jsonc", '{"enabled":false,"revision":"revoked"}');
    const result = await pending;
    expect(aborted).toBe(true);
    expect(result.status.semantic.state).toBe("unavailable");
    expect(result.hits).toEqual([]);
  });

  test("provider failure/bad dimensions preserve lexical hits without leaking diagnostics", async () => {
    const root = await fixture();
    await put(root, "auth.ts", "renewCredentials");
    for (const embed of [async () => { throw new Error("Bearer secret-fixture"); }, async () => [[1, 0]]]) {
      const result = await searchNative(root, request({ query: "renewCredentials" }), { key: async () => "fixture", embed });
      expect(result.hits[0].path).toBe("auth.ts");
      expect(result.status.mode).toBe("lexical");
      expect(result.status.semantic.state).toBe("unavailable");
      expect(result.notices.join(" ")).not.toContain("secret-fixture");
    }
  });

  test("expiring lease ownership excludes duplicate publishers and never clears another owner", async () => {
    const root = await fixture();
    const a = await openVectorStore(root), b = await openVectorStore(root);
    try {
      const token = a.acquire("model");
      expect(typeof token).toBe("string");
      expect(b.acquire("model")).toBeUndefined();
      b.release("model", "wrong-token");
      expect(b.acquire("model")).toBeUndefined();
      const db = new Database(join(root, ".pi/search/code.sqlite"));
      db.exec("UPDATE leases SET expires=0"); db.close();
      expect(() => a.renew("model", token)).toThrow("Vector lease lost");
      const replacement = b.acquire("model");
      expect(replacement).not.toBe(token);
      expect(() => a.renew("model", token)).toThrow("Vector lease lost");
      expect(() => a.put("model", token, [{ digest: "a", vector: [1, 0, 0] }], 3)).toThrow();
      a.release("model", token);
      b.put("model", replacement, [{ digest: "a", vector: [1, 0, 0] }], 3);
      expect(a.get("model", "a", 3)).toEqual([1, 0, 0]);
    } finally { a.close(); b.close(); }
  });

  test("unsafe global configuration/cache paths fail closed without modifying their targets", async () => {
    const outside = await fixture(), root = await fixture(), provider = fakeProvider();
    await put(root, "auth.ts", "renewCredentials");
    await rm(settingsPath(root));
    await symlink(settingsPath(outside), settingsPath(root));
    expect(await repositoryEmbeddingSettings(root)).toBeUndefined();
    await searchNative(root, request(), provider);
    expect(provider.calls).toEqual([]);
    await put(outside, "cache", "unchanged");
    await rm(join(root, ".pi/search/code.sqlite"));
    await symlink(join(outside, "cache"), join(root, ".pi/search/code.sqlite"));
    await expect(openVectorStore(root)).rejects.toThrow();
    expect(await readFile(join(outside, "cache"), "utf8")).toBe("unchanged");
  });
});

test("HTTP decoder validates model/count/index/dimension and does not expose provider error bodies", async () => {
  const original = globalThis.fetch;
  const cfg = { provider: "openrouter", model: "fixture/code", dimension: 3, baseUrl: "https://fixture.invalid" };
  try {
    let payload: any = { model: "code", object: "list", data: [{ object: "embedding", index: 0, embedding: [1, 0, 0] }] };
    globalThis.fetch = (async (_url: any, init: any) => {
      expect(JSON.parse(init.body).input).toEqual(["fixture"]);
      return new Response(JSON.stringify(payload));
    }) as typeof fetch;
    expect(await embedRepository(["fixture"], cfg, "fixture-only", new AbortController().signal)).toEqual([[1, 0, 0]]);
    for (const bad of [{ ...payload, model: "other" }, { ...payload, data: [] }, { ...payload, data: [{ object: "embedding", index: 0, embedding: [0, 0, 0] }] }]) {
      const good = payload; payload = bad;
      await expect(embedRepository(["fixture"], cfg, "fixture-only", new AbortController().signal)).rejects.toThrow();
      payload = good;
    }
  } finally { globalThis.fetch = original; }
});
