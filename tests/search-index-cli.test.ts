import assert from "node:assert/strict";
import { test } from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { removeDirsWithRetry } from "../external/pi-tools-suite/test/support/fs-retry.mjs";
import { join, resolve } from "node:path";
import { parseIndexArgs } from "../scripts/search-index.js";
import { settingsDocuments, hashText } from "../acp/src/search/documents.js";
import { embeddingMetadata } from "../acp/src/search/embedding-cache.js";
import { SETTINGS_SEARCH_CATALOG } from "../desktop/src/lib/settings-search-catalog.js";

test("CLI grammar requires an explicit paid indexing target and supports all six sources", () => {
  for (const source of ["settings", "sessions", "tasks", "commits", "code", "knowledge", "all"]) {
    assert.equal(parseIndexArgs(["index", source]).target, source);
    assert.equal(parseIndexArgs(["continue", source]).action, "continue");
  }
  for (const args of [["index"], ["continue"], ["index", "typo"], ["status", "all", "extra"], ["--project"], ["enable", "all"]]) assert.throws(() => parseIndexArgs(args));
  assert.equal(parseIndexArgs([]).action, "status");
});

test("shell status/check/stop are provider-free and do not initialize a fresh project", async t => {
  const base = resolve(".pi/artifacts/search-index-cli-tests");
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(join(base, "run-"));
  t.after(() => removeDirsWithRetry([root]));
  for (const action of ["status", "check", "stop"]) {
    const { stdout } = await promisify(execFile)(process.execPath, ["--import", "tsx", "scripts/search-index.ts", action, "--project", root], {
      env: { ...process.env, HOME: root, OPENROUTER_API_KEY: "", PI_CODING_AGENT_DIR: join(root, "agent") }, timeout: 20000,
    });
    const result = JSON.parse(stdout);
    assert.equal(result.action, action);
    assert.equal(Object.keys(result.sources).length, 6);
  }
  await assert.rejects(stat(join(root, ".pi")), { code: "ENOENT" });
});

test("all six shell index adapters fail safely without a configured provider", async t => {
  const base = resolve(".pi/artifacts/search-index-cli-tests");
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(join(base, "run-"));
  t.after(() => removeDirsWithRetry([root]));
  const sources = ["code", "knowledge", "settings", "sessions", "tasks", "commits"];
  await mkdir(join(root, ".pi"));
  await mkdir(join(root, ".config/pi"), { recursive: true });
  await writeFile(join(root, ".config/pi/pi-tools-suite.jsonc"), "{}");
  await writeFile(join(root, ".pi/workspace.jsonc"), JSON.stringify({ search: { sources: Object.fromEntries(sources.filter(source => source !== "settings").map(source => [source, true])) } }));
  for (const source of [...sources, "all"]) {
    const result = await promisify(execFile)(process.execPath, ["--import", "tsx", "scripts/search-index.ts", "index", source, "--project", root], {
      env: { ...process.env, HOME: root, OPENROUTER_API_KEY: "", PI_CODING_AGENT_DIR: join(root, "agent") }, timeout: 30000,
    }).then(() => { throw new Error("Unconfigured indexing must not claim completion"); }, error => error);
    assert.equal(result.code, 2, result.stderr);
    const parsed = JSON.parse(result.stdout);
    if (source === "all") {
      assert.deepEqual(Object.keys(parsed.results).sort(), [...sources].sort());
      for (const value of Object.values(parsed.results) as Array<{ complete: boolean }>) assert.equal(value.complete, false);
    } else assert.equal(parsed.results[source].complete, false);
  }
});

test("shell migrates compatible Settings once without a provider and toggles it globally", async t => {
  const base = resolve(".pi/artifacts/search-index-cli-tests");
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(join(base, "global-")), a = join(root, "a"), b = join(root, "b");
  t.after(() => removeDirsWithRetry([root]));
  await mkdir(join(a, ".pi/search"), { recursive: true }); await mkdir(b);
  await mkdir(join(root, ".config/pi"), { recursive: true });
  await writeFile(join(root, ".config/pi/pi-tools-suite.jsonc"), JSON.stringify({ search: { embedding: {
    embeddingProvider: "ollama", embeddingModel: "fixture", vectorSize: 3, ollamaBaseUrl: "http://127.0.0.1:1",
  } } }));
  const filename = join(a, ".pi/search/settings.sqlite"), db = new DatabaseSync(filename);
  try {
    db.exec("CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT); CREATE TABLE documents(id TEXT PRIMARY KEY,text TEXT,hit TEXT,hashes TEXT); CREATE TABLE vectors(hash TEXT PRIMARY KEY,vector BLOB)");
    const identity = embeddingMetadata({ provider: "ollama", model: "fixture", dimension: 3, queryPrefix: "search_query: ", documentPrefix: "search_document: ", baseUrl: "http://127.0.0.1:1" });
    for (const [key, value] of Object.entries({ schema: "2", ...identity })) db.prepare("INSERT INTO metadata VALUES(?,?)").run(key, value);
    const entry = SETTINGS_SEARCH_CATALOG[0]!;
    const doc = settingsDocuments([{ ...entry, description: entry.description ?? "", synonyms: [...entry.synonyms] }])[0]!;
    db.prepare("INSERT INTO documents VALUES(?,?,?,?)").run(doc.hit.id, doc.text, JSON.stringify(doc.hit), JSON.stringify(doc.chunks.map(hashText)));
    for (const chunk of doc.chunks) { const vector = Buffer.alloc(12); vector.writeFloatLE(1); db.prepare("INSERT INTO vectors VALUES(?,?)").run(hashText(chunk), vector); }
  } finally { db.close(); }
  const before = await readFile(filename);
  const run = async (args: string[], project = a) => JSON.parse((await promisify(execFile)(process.execPath,
    ["--import", "tsx", "scripts/search-index.ts", ...args, "--project", project], {
      env: { ...process.env, HOME: root, OPENROUTER_API_KEY: "", PI_CODING_AGENT_DIR: join(root, "agent") }, timeout: 20000,
    })).stdout);
  for (const project of [a, b, a]) {
    const migrated = await run(["migrate", "settings"], project);
    assert.equal(migrated.reusableVectors, 1); assert.equal(migrated.providerRequests, 0);
    assert.equal(migrated.path, join(root, ".config/pi/search/settings.sqlite"));
  }
  assert.deepEqual(await readFile(filename), before);
  await run(["disable", "settings"]);
  assert.equal((await run(["status", "settings"], b)).sources.settings.enabled, false);
  await run(["enable", "settings"], b);
  assert.equal((await run(["status", "settings"])).sources.settings.enabled, true);
  await assert.rejects(stat(join(b, ".pi")), { code: "ENOENT" });
});
