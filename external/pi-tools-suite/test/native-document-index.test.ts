import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { indexNative, searchNative } from "../src/project-search/native-engine.mjs";
import { openVectorStore } from "../src/project-search/native-vector-store.mjs";
import { repositoryEmbeddingSettings } from "../src/project-search/native-embedding-provider.mjs";
import type { NativeIndexRequest, NativeIndexResponse } from "../src/project-search/native-contract.ts";
import { removeDirsWithRetry } from "./support/fs-retry.js";
import { enableSearchSources } from "./support/search-sources.js";
import { writeSourcePolicy } from "../src/project-search/source-policy.mjs";

const artifacts = fileURLToPath(new URL("../../../.pi/artifacts/", import.meta.url));
const cli = fileURLToPath(new URL("../src/project-search/native-cli.mjs", import.meta.url));
const roots: string[] = [];
const originalHome = process.env.HOME;
const config = { embeddingProvider: "openrouter", embeddingModel: "fixture/code", knowledgeEmbeddingModel: "fixture/docs",
  vectorSize: 3, knowledgeEmbeddingQueryPrefix: "question: ", knowledgeEmbeddingDocumentPrefix: "passage: " };
const request = (source: "code" | "knowledge" = "code"): NativeIndexRequest => ({ operation: "index", source });
const settingsFile = (root: string) => join(root, "../.config/pi/pi-tools-suite.jsonc");
async function put(root: string, name: string, text: string) {
  await mkdir(join(root, name, ".."), { recursive: true });
  await writeFile(join(root, name), text);
}
async function fixture() {
  await mkdir(artifacts, { recursive: true });
  const home = await mkdtemp(join(artifacts, "native-document-index-"));
  roots.push(home); process.env.HOME = home;
  const root = join(home, "project");
  await mkdir(root);
  enableSearchSources(root);
  await put(root, "../.config/pi/pi-tools-suite.jsonc", JSON.stringify({ search: { embedding: config } }));
  return root;
}
function provider() {
  const calls: { inputs: string[]; model: string }[] = [];
  return { calls, key: async () => "fixture-only", embed: async (inputs: string[], cfg: any) => {
    calls.push({ inputs, model: cfg.model });
    return inputs.map(() => Array.from({ length: cfg.dimension }, (_, i) => i === 0 ? 1 : 0));
  } };
}
function cached(root: string) {
  return ["code", "knowledge"].reduce((count, source) => {
    const filename = join(root, `.pi/search/${source}.sqlite`);
    if (!existsSync(filename)) return count;
    const db = new Database(filename, { readonly: true });
    try {
      return count + (db.query("SELECT name FROM sqlite_master WHERE name='vectors'").get()
        ? (db.query("SELECT COUNT(*) AS n FROM vectors").get() as any).n : 0);
    } finally { db.close(); }
  }, 0);
}
async function child(root: string, payload: any, executable = "node", preload?: string): Promise<NativeIndexResponse> {
  return new Promise((resolve, reject) => {
    const proc = spawn(executable, [...(preload ? ["--import", pathToFileURL(preload).href] : []), cli, root], {
      stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, OPENROUTER_API_KEY: "" },
    });
    const chunks: Buffer[] = [], errors: Buffer[] = [];
    proc.stdout.on("data", chunk => chunks.push(chunk));
    proc.stderr.on("data", chunk => errors.push(chunk));
    proc.on("error", reject);
    proc.on("close", code => {
      if (code !== 0) reject(new Error(Buffer.concat(errors).toString()));
      else { try { resolve(JSON.parse(Buffer.concat(chunks).toString())); } catch (error) { reject(error); } }
    });
    proc.stdin.end(JSON.stringify(payload));
  });
}
afterEach(async () => {
  if (originalHome === undefined) delete process.env.HOME; else process.env.HOME = originalHome;
  await removeDirsWithRetry(roots);
});

describe("explicit native document indexing", () => {
  test("isolates sources/models and embeds documents only, with no synthetic query cache", async () => {
    const root = await fixture(), fake = provider();
    await put(root, "auth.ts", "renewCredentials");
    await put(root, "docs.md", "# Token rotation\nrenewCredentials");
    const before = await readFile(settingsFile(root));
    expect(await indexNative(root, request(), fake)).toEqual({ source: "code", complete: true, indexed: 1, total: 1 });
    expect(fake.calls).toEqual([{ inputs: ["auth.ts\nauth.ts\nrenewCredentials"], model: "fixture/code" }]);
    expect(cached(root)).toBe(1);
    fake.calls.length = 0;
    expect(await indexNative(root, request("knowledge"), fake)).toEqual({ source: "knowledge", complete: true, indexed: 1, total: 1 });
    expect(fake.calls).toEqual([{ inputs: ["passage: docs.md\nToken rotation\n# Token rotation\nrenewCredentials"], model: "fixture/docs" }]);
    expect(cached(root)).toBe(2);
    expect(await readFile(settingsFile(root))).toEqual(before);
    fake.calls.length = 0;
    const result = await searchNative(root, { query: "rotation", sources: ["knowledge"], mode: "semantic" }, fake);
    expect(result.hits[0].path).toBe("docs.md");
    expect(fake.calls).toEqual([{ inputs: ["question: rotation"], model: "fixture/docs" }]);
  });

  test("one pass drains beyond 128 missing chunks and repeated clicks reuse compatible vectors", async () => {
    const root = await fixture(), fake = provider();
    for (let i = 0; i < 130; i++) await put(root, `f${i}.ts`, "needle");
    const first = await indexNative(root, request(), fake);
    expect(first).toMatchObject({ source: "code", complete: true, indexed: 130, total: 130 });
    expect(fake.calls.flatMap(call => call.inputs)).toHaveLength(130);
    expect(fake.calls.every(call => call.inputs.length <= 16)).toBe(true);
    fake.calls.length = 0;
    expect(await indexNative(root, request(), fake)).toEqual({ source: "code", complete: true, indexed: 130, total: 130 });
    expect(fake.calls.flatMap(call => call.inputs)).toHaveLength(0);
    fake.calls.length = 0;
    expect((await indexNative(root, request(), fake)).complete).toBe(true);
    expect(fake.calls).toEqual([]);
    expect(cached(root)).toBe(130);
  });

  test("edits, renames and deletions refresh document coverage without erasing paid vectors", async () => {
    const root = await fixture(), fake = provider();
    await put(root, "a.ts", "original");
    await put(root, "b.ts", "unchanged");
    await indexNative(root, request(), fake);
    fake.calls.length = 0;
    await put(root, "a.ts", "changed");
    expect((await indexNative(root, request(), fake)).complete).toBe(true);
    expect(fake.calls.flatMap(call => call.inputs)).toEqual(["a.ts\na.ts\nchanged"]);
    await rename(join(root, "a.ts"), join(root, "renamed.ts"));
    await indexNative(root, request(), fake);
    await rm(join(root, "renamed.ts"));
    fake.calls.length = 0;
    expect(await indexNative(root, request(), fake)).toEqual({ source: "code", complete: true, indexed: 1, total: 1 });
    expect(fake.calls).toEqual([]);
    expect(cached(root)).toBe(4);
  });

  test("changed model identities coexist and restoring compatible configuration reuses cache", async () => {
    const root = await fixture(), fake = provider();
    await put(root, "a.ts", "needle");
    await indexNative(root, request(), fake);
    await put(root, "../.config/pi/pi-tools-suite.jsonc", JSON.stringify({ search: { embedding: { ...config, embeddingModel: "fixture/new", vectorSize: 4 } } }));
    fake.calls.length = 0;
    expect((await indexNative(root, request(), fake)).complete).toBe(true);
    expect(fake.calls[0].model).toBe("fixture/new");
    expect(cached(root)).toBe(2);
    await put(root, "../.config/pi/pi-tools-suite.jsonc", JSON.stringify({ search: { embedding: config } }));
    fake.calls.length = 0;
    expect((await indexNative(root, request(), fake)).complete).toBe(true);
    expect(fake.calls).toEqual([]);
  });

  test("empty source is verified only with valid saved configuration", async () => {
    const root = await fixture(), fake = provider();
    await put(root, "docs.md", "knowledge only");
    expect(await indexNative(root, request(), fake)).toEqual({ source: "code", complete: true, indexed: 0, total: 0 });
    expect(fake.calls).toEqual([]);
    await put(root, "../.config/pi/pi-tools-suite.jsonc", "{}");
    expect(await indexNative(root, request(), fake)).toMatchObject({ source: "code", complete: false, message: expect.stringContaining("configuration") });
  });

  test("invalid union arguments fail before uploads or storage creation", async () => {
    const root = await fixture(), fake = provider();
    for (const invalid of [null, [], {}, { operation: "index" }, { operation: "index", source: "sessions" },
      { ...request(), query: "synthetic" }, { ...request(), sources: ["knowledge"] }, { ...request(), pathPrefix: "src" },
      { ...request(), operation: "search" }]) {
      const result = await indexNative(root, invalid, fake);
      expect(result.complete).toBe(false);
      expect(result).not.toHaveProperty("hits");
    }
    expect(fake.calls).toEqual([]);
    expect(await readFile(join(root, ".pi/search/files.sqlite")).catch(() => undefined)).toBeUndefined();
    expect((await searchNative(root, { ...request(), query: "needle", sources: ["code"] }, fake)).status.complete).toBe(false);
  });

  test("missing, malformed, invalid and redirected configuration fails closed", async () => {
    const root = await fixture(), fake = provider();
    await put(root, "a.ts", "needle");
    for (const text of ["{}", "{broken", JSON.stringify({ search: { embedding: { ...config, vectorSize: 0 } } })]) {
      await put(root, "../.config/pi/pi-tools-suite.jsonc", text);
      expect((await indexNative(root, request(), fake)).complete).toBe(false);
    }
    await rm(settingsFile(root));
    expect((await indexNative(root, request(), fake)).complete).toBe(false);
    await put(root, "../outside.json", JSON.stringify({ search: { embedding: config } }));
    await symlink(join(root, "../outside.json"), settingsFile(root));
    expect((await indexNative(root, request(), fake)).complete).toBe(false);
    expect(fake.calls).toEqual([]);
    expect(cached(root)).toBe(0);
  });

  test("unsafe cache paths cannot be replaced or reported complete", async () => {
    const root = await fixture(), fake = provider();
    await put(root, "a.ts", "needle");
    await put(root, ".pi/search/outside", "untouched");
    await symlink(join(root, ".pi/search/outside"), join(root, ".pi/search/code.sqlite"));
    expect((await indexNative(root, request(), fake)).complete).toBe(false);
    expect(fake.calls).toEqual([]);
    expect(await readFile(join(root, ".pi/search/outside"), "utf8")).toBe("untouched");
  });

  test("missing credentials and competing leases return truthful partial coverage", async () => {
    const root = await fixture(), fake = provider();
    await put(root, "a.ts", "needle");
    expect(await indexNative(root, request(), { ...fake, key: async () => undefined })).toMatchObject({ complete: false, indexed: 0, total: 1 });
    const vectors = await openVectorStore(root), settings = await repositoryEmbeddingSettings(root);
    const identity = settings!.configs.code.identity, token = vectors.acquire(identity);
    try {
      expect(await indexNative(root, request(), fake)).toMatchObject({ complete: false, indexed: 0, total: 1 });
      expect(fake.calls).toEqual([]);
    } finally { vectors.release(identity, token); vectors.close(); }
    expect((await indexNative(root, request(), fake)).complete).toBe(true);
    fake.calls.length = 0;
    expect((await indexNative(root, request(), { ...fake, key: async () => undefined })).complete).toBe(true);
    expect(fake.calls).toEqual([]);
  });

  test("generation changes discard stale documents without locking local refresh", async () => {
    const root = await fixture(), fake = provider();
    await put(root, "a.ts", "needle");
    let enter!: () => void, finish!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; });
    const gate = new Promise<void>(resolve => { finish = resolve; });
    const pending = indexNative(root, request(), { ...fake, embed: async (inputs: string[], cfg: any) => {
      enter(); await gate; return fake.embed(inputs, cfg);
    } });
    await entered;
    await put(root, "a.ts", "changed");
    expect((await searchNative(root, { query: "changed", sources: ["code"], mode: "lexical" })).status.complete).toBe(true);
    finish();
    expect(await pending).toMatchObject({ source: "code", complete: false, message: expect.stringContaining("snapshot changed") });
    expect(cached(root)).toBe(0);
    expect((await indexNative(root, request(), fake)).complete).toBe(true);
  });

  test("a saved provider identity change rejects ignored-cancellation late completions", async () => {
    const root = await fixture(), fake = provider();
    await put(root, "a.ts", "needle");
    let enter!: () => void, finish!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; });
    const gate = new Promise<void>(resolve => { finish = resolve; });
    const pending = indexNative(root, request(), { ...fake, embed: async (inputs: string[], cfg: any) => {
      enter(); await gate; return fake.embed(inputs, cfg);
    } });
    await entered;
    await put(root, "../.config/pi/pi-tools-suite.jsonc", JSON.stringify({ search: { embedding: { ...config, embeddingModel: "fixture/new" } } }));
    finish();
    expect((await pending).complete).toBe(false);
    expect(cached(root)).toBe(0);
    fake.calls.length = 0;
    expect((await indexNative(root, request(), fake)).complete).toBe(true);
    expect(fake.calls[0].model).toBe("fixture/new");
  });

  test("incomplete source discovery cannot label retained paid coverage as current", async () => {
    const root = await fixture(), fake = provider();
    await put(root, "a.md", "needle");
    expect((await indexNative(root, request("knowledge"), fake)).complete).toBe(true);
    fake.calls.length = 0;
    await put(root, "dense.md", Array.from({ length: 20001 }, (_, i) => `## h${i}`).join("\n"));
    const result = await indexNative(root, request("knowledge"), fake);
    expect(result.complete).toBe(false);
    expect(result.message).toContain("freshness is unverified");
    expect(result).not.toHaveProperty("indexed");
    expect(fake.calls).toEqual([]);
    expect(cached(root)).toBe(1);
  });

  test.skipIf(process.platform === "win32")("scan cancellation terminates the owned Git enumerator before publication", async () => {
    const root = await fixture(), fake = provider();
    const bin = join(root, "../bin"), marker = join(root, "../git-started");
    await mkdir(bin);
    const executable = join(bin, "git");
    await writeFile(executable, `#!/bin/sh\nprintf started > '${marker}'\nexec /bin/sleep 30\n`);
    await chmod(executable, 0o755);
    const previousPath = process.env.PATH, controller = new AbortController();
    let pending: Promise<NativeIndexResponse> | undefined;
    try {
      process.env.PATH = bin;
      pending = indexNative(root, request(), { ...fake, signal: controller.signal });
      let entered = false;
      for (let i = 0; i < 100; i++) {
        if (await readFile(marker, "utf8").catch(() => "") === "started") { entered = true; break; }
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      expect(entered).toBe(true);
      controller.abort();
      expect((await pending).complete).toBe(false);
      expect(fake.calls).toEqual([]);
      expect(cached(root)).toBe(0);
    } finally {
      try { controller.abort(); await pending?.catch(() => {}); }
      finally { if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath; }
    }
  });

  test("source-policy revocation returns an incomplete index result without publishing late vectors", async () => {
    const root = await fixture(), fake = provider();
    await put(root, "a.ts", "needle");
    const result = await indexNative(root, request(), { ...fake, embed: async (inputs: string[], cfg: any) => {
      await writeSourcePolicy(root, "code", false);
      await writeSourcePolicy(root, "code", true);
      return fake.embed(inputs, cfg);
    } });
    expect(result).toMatchObject({ source: "code", complete: false, message: expect.any(String) });
    expect(result).not.toHaveProperty("indexed");
    expect(cached(root)).toBe(0);
    expect((await indexNative(root, request(), fake)).complete).toBe(true);
  });

  test("cancellation/revocation abort owned work, release leases, and reject late vectors", async () => {
    const root = await fixture(), fake = provider();
    await put(root, "a.ts", "needle");
    const already = new AbortController(); already.abort();
    expect((await indexNative(root, request(), { ...fake, signal: already.signal })).complete).toBe(false);
    expect(fake.calls).toEqual([]);
    for (const revoke of [false, true]) {
      const controller = new AbortController();
      let enter!: () => void, aborted = false;
      const entered = new Promise<void>(resolve => { enter = resolve; });
      const pending = indexNative(root, request(), { ...fake, signal: controller.signal,
        embed: async (_inputs: string[], _cfg: any, _key: any, signal: AbortSignal) => {
          enter();
          await new Promise((_, reject) => signal.addEventListener("abort", () => {
            aborted = true; reject(new Error("fixture secret"));
          }, { once: true }));
        },
      });
      await entered;
      if (revoke) await put(root, "../.config/pi/pi-tools-suite.jsonc", "{}"); else controller.abort();
      const result = await pending;
      expect(aborted).toBe(true);
      expect(result.complete).toBe(false);
      expect(result).not.toHaveProperty("indexed");
      expect(JSON.stringify(result)).not.toContain("fixture secret");
      expect(cached(root)).toBe(0);
      const vectors = await openVectorStore(root);
      const db = new Database(join(root, ".pi/search/code.sqlite"), { readonly: true });
      try { expect((db.query("SELECT COUNT(*) AS n FROM leases").get() as any).n).toBe(0); }
      finally { db.close(); vectors.close(); }
    }
  });

  test("provider failures keep previously completed batches and retries embed only missing documents", async () => {
    const root = await fixture(), fake = provider();
    for (let i = 0; i < 18; i++) await put(root, `f${i}.ts`, "needle");
    let count = 0;
    const result = await indexNative(root, request(), { ...fake, embed: async (inputs: string[], cfg: any) => {
      if (++count === 2) throw new Error("Bearer fixture secret");
      return fake.embed(inputs, cfg);
    } });
    expect(result.complete).toBe(false);
    expect(result).not.toHaveProperty("indexed");
    expect(JSON.stringify(result)).not.toContain("fixture secret");
    expect(cached(root)).toBe(16);
    fake.calls.length = 0;
    expect(await indexNative(root, request(), fake)).toEqual({ source: "code", complete: true, indexed: 18, total: 18 });
    expect(fake.calls.flatMap(call => call.inputs)).toHaveLength(2);
  });

  test("malformed provider vectors never publish or imply complete coverage", async () => {
    const root = await fixture(), fake = provider();
    await put(root, "a.ts", "needle");
    for (const embed of [async () => [], async () => [[1, 0]], async () => [[0, 0, 0]]]) {
      expect((await indexNative(root, request(), { ...fake, embed })).complete).toBe(false);
      expect(cached(root)).toBe(0);
    }
  });

  test("CLI accepts the strict union and failures are index-shaped in Node and Bun", async () => {
    const root = await fixture();
    for (const executable of ["node", "bun"]) {
      expect(await child(root, request("knowledge"), executable)).toEqual({ source: "knowledge", complete: true, indexed: 0, total: 0 });
    }
    await put(root, "../.config/pi/pi-tools-suite.jsonc", "{}");
    for (const executable of ["node", "bun"]) {
      for (const payload of [request("knowledge"), { ...request("knowledge"), query: "not allowed" }]) {
        const result = await child(root, payload, executable);
        expect(result).toMatchObject({ source: "knowledge", complete: false, message: expect.any(String) });
        expect(result).not.toHaveProperty("hits");
      }
      expect(await child(join(root, "missing"), request(), executable)).toMatchObject({ source: "code", complete: false });
    }
  });

  test("manual indexing renews leases and passes the old overall deadlines", async () => {
    const root = await fixture(), fake = provider();
    for (let i = 0; i < 130; i++) await put(root, `f${i}.ts`, `const item${i} = ${i};`);
    const start = Date.now(); let now = start;
    const clock = spyOn(Date, "now").mockImplementation(() => now);
    try {
      const result = await indexNative(root, request(), { ...fake, embed: async (inputs: string[], cfg: any) => {
        now += 10_000;
        expect(inputs.length).toBeLessThanOrEqual(16);
        return fake.embed(inputs, cfg);
      } });
      expect(result).toMatchObject({ complete: true, indexed: 130, total: 130 });
      expect(now - start).toBeGreaterThan(60_000);
      expect(cached(root)).toBe(130);
    } finally { clock.mockRestore(); }
  });

  test("CLI clears the overall timer for index requests but keeps the search timer", async () => {
    const root = await fixture();
    const preload = join(root, "../timeout-preload.mjs");
    await writeFile(preload, `const original = globalThis.setTimeout, cancel = globalThis.clearTimeout;
let deadline;
globalThis.setTimeout = (callback, delay, ...args) => {
  if (delay === 40000) {
    const token = deadline = original(() => {}, delay);
    process.stdin.once('end', () => setImmediate(() => { if (deadline === token) callback(); }));
    return token;
  }
  return original(callback, delay, ...args);
};
globalThis.clearTimeout = token => { if (deadline === token) deadline = undefined; return cancel(token); };`);
    expect(await child(root, request("knowledge"), "node", preload)).toEqual({
      source: "knowledge", complete: true, indexed: 0, total: 0,
    });
    expect(await child(root, { query: "needle", sources: ["code"], mode: "lexical" }, "node", preload)).toMatchObject({
      notices: ["Native search timed out; results are incomplete."],
    });
  });
});
