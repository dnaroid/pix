import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile, symlink } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { searchNative } from "../src/project-search/native-engine.mjs";
import { repositoryRerankerSettings, rerankRepository, rerankNativeHits } from "../src/project-search/native-reranker.mjs";
import { enableSearchSources } from "./support/search-sources.js";
import { removeDirsWithRetry } from "./support/fs-retry.js";
import { writeSourcePolicy } from "../src/project-search/source-policy.mjs";

const roots: string[] = [], homeBefore = process.env.HOME;
const artifacts = fileURLToPath(new URL("../../../.pi/artifacts/", import.meta.url));
const model = "voyageai/rerank-3-lite";
let settingsFile: string;
async function configure(value: unknown = model) {
  await writeFile(settingsFile, JSON.stringify({ search: { rerankerModel: value } }));
}
async function fixture() {
  await mkdir(artifacts, { recursive: true });
  const home = await mkdtemp(join(artifacts, "native-reranker-")); roots.push(home); process.env.HOME = home;
  const root = join(home, "project"); await mkdir(root);
  enableSearchSources(root);
  settingsFile = join(home, ".config/pi/pi-tools-suite.jsonc");
  await mkdir(join(home, ".config/pi"), { recursive: true }); await configure();
  await writeFile(join(root, "a.ts"), "needle alpha");
  await writeFile(join(root, "b.ts"), "needle beta");
  await writeFile(join(root, "c.md"), "# needle\nBest passage");
  return root;
}
const request = (extra = {}) => ({ query: "needle", sources: ["code", "knowledge"], ...extra });
function provider() {
  const calls: { query: string; documents: string[]; model: string }[] = [];
  return { calls, rerankerKey: async () => "fixture-key", rerank: async (query: string, documents: string[], model: string) => {
    calls.push({ query, documents, model });
    return documents.map((text, index) => ({ index, relevance_score: text.includes("Best passage") ? 0.99 : 0.1 }));
  } };
}
afterEach(async () => {
  if (homeBefore === undefined) delete process.env.HOME; else process.env.HOME = homeBefore;
  await removeDirsWithRetry(roots);
});

describe("optional native repository reranker", () => {
  test("reranks once across domains before final limit, independent of embeddings and output content", async () => {
    const root = await fixture(), p = provider();
    const result = await searchNative(root, request({ limit: 1 }), p);
    expect(p.calls).toHaveLength(1);
    expect(p.calls[0].model).toBe(model);
    expect(p.calls[0].documents).toHaveLength(3);
    expect(p.calls[0].documents.some(text => text.includes("Best passage"))).toBe(true);
    expect(result.hits[0].path).toBe("c.md");
    expect(result.hits[0].score).toBe(0.99);
    expect(result.hits[0]).not.toHaveProperty("content");
    expect(result.status).toMatchObject({ rerankerEnabled: true, semanticEnabled: false });
    expect(result.status.completeForSelection).toBe(true);
    expect(result.limitNotices).toEqual([]);
  });
  test("lexical, empty results, disabled sources and empty/malformed settings do not call the provider", async () => {
    const root = await fixture(), p = provider();
    const lexical = await searchNative(root, request({ mode: "lexical" }), p);
    expect(lexical.status.rerankerEnabled).toBe(true);
    await searchNative(root, request({ query: "missingword" }), p);
    await searchNative(root, request({ sources: ["knowledge"], pathPrefix: "code" }), p);
    for (const value of ["", "  ", null, {}, "bad\0model"]) {
      await configure(value);
      expect(await repositoryRerankerSettings()).toBeUndefined();
      expect((await searchNative(root, request(), p)).hits).toHaveLength(3);
    }
    await configure();
    await writeSourcePolicy(root, "knowledge", false);
    const disabled = await searchNative(root, request({ sources: ["knowledge"] }), p);
    expect(disabled.hits).toEqual([]);
    expect(disabled.status).toMatchObject({ complete: true, completeForSelection: true, stale: false });
    expect(p.calls).toEqual([]);
  });
  test("project-local configuration and redirected global settings never authorize reranking", async () => {
    const root = await fixture(), p = provider();
    await configure("");
    await writeFile(join(root, ".pi/pi-tools-suite.jsonc"), JSON.stringify({ search: { rerankerModel: model } }));
    await searchNative(root, request(), p);
    const redirected = settingsFile + ".real";
    await writeFile(redirected, JSON.stringify({ search: { rerankerModel: model } }));
    const { unlink } = await import("node:fs/promises"); await unlink(settingsFile); await symlink(redirected, settingsFile);
    expect(await repositoryRerankerSettings()).toBeUndefined();
    expect(p.calls).toEqual([]);
  });
  test("bad response, missing key or provider failure retains the original ordering and redacts errors", async () => {
    const root = await fixture();
    await configure(""); const original = await searchNative(root, request()); await configure();
    const failures = [[], [{ index: 0, relevance_score: NaN }],
      Array(3).fill({ index: 0, relevance_score: 0.7 }),
      [{ index: 99, relevance_score: 0.7 }, { index: 1, relevance_score: 0.2 }, { index: 2, relevance_score: 0.1 }]];
    for (const invalid of failures) {
      const result = await searchNative(root, request(), { rerankerKey: async () => "key", rerank: async () => invalid });
      expect(result.hits).toEqual(original.hits);
      expect(result.notices.join(" ")).toContain("original ranking retained");
      expect(result.status.complete).toBe(original.status.complete);
      expect(result.status.completeForSelection).toBe(false);
      expect(result.limitNotices).toEqual([]);
    }
    for (const dependencies of [{ rerankerKey: async () => undefined },
      { rerankerKey: async () => "key", rerank: async () => { throw new Error("secret-provider-body"); } }]) {
      const result = await searchNative(root, request(), dependencies);
      expect(result.hits).toEqual(original.hits);
      expect(JSON.stringify(result)).not.toContain("secret-provider-body");
      expect(result.status.completeForSelection).toBe(false);
    }
  });
  test("configuration revocation aborts in-flight transport and drops late ranking", async () => {
    const root = await fixture(); let aborted = false;
    const result = await searchNative(root, request(), { rerankerKey: async () => "key",
      rerank: async (_q: string, _d: string[], _m: string, _k: string, signal: AbortSignal) => {
        await configure("");
        await new Promise<void>(resolve => signal.addEventListener("abort", () => { aborted = true; resolve(); }, { once: true }));
        return [{ index: 0, relevance_score: 1 }];
      } });
    expect(aborted).toBe(true);
    expect(result.hits).toHaveLength(3);
    expect(result.notices.join(" ")).toContain("original ranking retained");
    expect(result.status.completeForSelection).toBe(false);
  });
  test("caller cancellation rejects instead of publishing late hits", async () => {
    const root = await fixture(), caller = new AbortController();
    await expect(searchNative(root, request(), { signal: caller.signal, rerankerKey: async () => "key",
      rerank: async () => { caller.abort(); return []; } })).rejects.toThrow();
  });
  test("changed candidate bytes during reranking reject the remote ranking", async () => {
    const root = await fixture(), p = provider();
    const result = await searchNative(root, request(), { ...p, rerank: async (...args: Parameters<typeof p.rerank>) => {
      const ranked = await p.rerank(...args);
      await writeFile(join(root, "c.md"), "# needle\nChanged passage"); return ranked;
    } });
    expect(result.notices.join(" ")).toContain("original ranking retained");
    expect(result.hits.map((hit: any) => hit.score)).not.toContain(0.99);
    expect(result.status.completeForSelection).toBe(false);
  });
  test("unchanged concurrent retrieval preserves generation and accepts ranking", async () => {
    const root = await fixture(), p = provider();
    const result = await searchNative(root, request(), { ...p, rerank: async (...args: Parameters<typeof p.rerank>) => {
      const ranked = await p.rerank(...args);
      await searchNative(root, request({ mode: "lexical" })); return ranked;
    } });
    expect(result.notices.join(" ")).not.toContain("original ranking retained");
    expect(result.hits[0].score).toBe(0.99);
    expect(result.status.completeForSelection).toBe(true);
  });
  test("changed concurrent retrieval still rejects the old generation", async () => {
    const root = await fixture(), p = provider();
    const result = await searchNative(root, request(), { ...p, rerank: async (...args: Parameters<typeof p.rerank>) => {
      const ranked = await p.rerank(...args);
      await writeFile(join(root, "b.ts"), "needle changed beta");
      await searchNative(root, request({ mode: "lexical" })); return ranked;
    } });
    expect(result.notices.join(" ")).toContain("original ranking retained");
    expect(result.hits.map((hit: any) => hit.score)).not.toContain(0.99);
    expect(result.status.completeForSelection).toBe(false);
  });
  test("source-policy revocation cancels and never publishes a remote result", async () => {
    const root = await fixture(), p = provider();
    await expect(searchNative(root, request(), { ...p, rerank: async (...args: Parameters<typeof p.rerank>) => {
      const ranked = await p.rerank(...args);
      await writeSourcePolicy(root, "knowledge", false);
      return ranked;
    } })).rejects.toThrow();
  });
  test("provider timeout cancels transport and preserves the original list", async () => {
    const root = await fixture(); let aborted = false;
    const result = await searchNative(root, request(), { rerankerKey: async () => "key",
      rerank: async (_q: string, _d: string[], _m: string, _k: string, signal: AbortSignal) => {
        await new Promise<void>(resolve => signal.addEventListener("abort", () => { aborted = true; resolve(); }, { once: true }));
        return [];
      } });
    expect(aborted).toBe(true);
    expect(result.hits).toHaveLength(3);
    expect(result.notices.join(" ")).toContain("original ranking retained");
  }, 15000);
  test("candidate count and document bytes are bounded before upload", async () => {
    await fixture();
    const settings = await repositoryRerankerSettings(), p = provider();
    const hits = Array.from({ length: 101 }, (_, index) => ({ id: String(index), kind: "code", path: `src/${index}.ts`, title: "needle", snippet: "s", content: "a".repeat(20000), score: index }));
    const result = await rerankNativeHits("needle", hits, settings, p, async () => {});
    expect(p.calls).toHaveLength(1);
    expect(p.calls[0].documents).toHaveLength(100);
    expect(p.calls[0].documents.every(text => text.length <= 8192)).toBe(true);
    expect(p.calls[0].documents.reduce((total, text) => total + Buffer.byteLength(text), Buffer.byteLength("needle"))).toBeLessThanOrEqual(32000);
    expect(result.notices.join(" ")).toContain("candidate limit");
    expect(result.limitNotices).toEqual(["Native reranking candidate limit reached; results are partial."]);
    expect(result.limitNotices.every(notice => result.notices.includes(notice))).toBe(true);
    expect(result.completeForSelection).toBe(true);
    expect(result.hits).toHaveLength(100);
  });
  test("dedupe chooses the best chunk after reranking and excluded paths/tests never upload", async () => {
    const root = await fixture(), p = provider();
    await writeFile(join(root, "c.md"), "# needle first\nweak\n# needle second\nBest passage");
    await writeFile(join(root, "needle.test.ts"), "needle test-only");
    const result = await searchNative(root, request({ sources: ["knowledge"], pathPrefix: "c.md", dedupeFile: true, includeContent: true, excludeTests: true }), p);
    expect(p.calls[0].documents).toHaveLength(2);
    expect(p.calls[0].documents.every(text => text.startsWith("c.md\n"))).toBe(true);
    expect(result.hits).toHaveLength(1);
    expect(result.hits[0].content).toContain("Best passage");
  });
  test("uses dedicated endpoint and request contract; bounds response bytes", async () => {
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = (async (url: any, init: any) => {
        expect(url).toBe("https://openrouter.ai/api/v1/rerank");
        expect(init.redirect).toBe("error");
        expect(JSON.parse(init.body)).toEqual({ model, query: "needle", documents: ["passage"], top_n: 1 });
        return new Response(JSON.stringify({ results: [{ index: 0, relevance_score: 0.75 }] }));
      }) as typeof fetch;
      expect(await rerankRepository("needle", ["passage"], model, "fixture-key", new AbortController().signal)).toEqual([{ index: 0, relevance_score: 0.75 }]);
      globalThis.fetch = (async () => new Response("x".repeat(128 * 1024 + 1))) as typeof fetch;
      await expect(rerankRepository("needle", ["passage"], model, "key", new AbortController().signal)).rejects.toThrow("too large");
    } finally { globalThis.fetch = originalFetch; }
  });
});
