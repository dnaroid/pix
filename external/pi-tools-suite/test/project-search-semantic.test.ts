import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Database } from "bun:sqlite";
import { searchProject, type ProjectSearchServices, type SessionRecord } from "../src/project-search/engine.js";
import { taskSemanticHash } from "../src/project-search/semantic-cache.js";
import { embedSemanticQuery } from "../src/project-search/semantic-provider.js";
import { cachedProjectSemantics } from "../src/project-search/semantic.js";
import { indexMissingSessionVectors } from "../src/project-search/semantic-session-indexer.js";
import { syncSessionChunks } from "../src/project-search/semantic-session-chunks.js";
import { syncSavedTaskVectors } from "../src/project-search/semantic-task-indexer.js";
import { resetHistoryVectors } from "../src/project-search/semantic-reset.js";
import { searchSemanticCommits } from "../src/project-search/semantic-commit-indexer.js";
import { commitIdentity, type CommitEmbeddingConfig } from "../src/project-search/semantic-commit-provider.js";
import { removeDirsWithRetry, renameWithRetry } from "./support/fs-retry.js";
import { enableSearchSources } from "./support/search-sources.js";

const scratch = fileURLToPath(new URL("../../../.pi/artifacts/project-search-semantic-tests/", import.meta.url));
const roots: string[] = [];
let originalHome: string | undefined;
beforeEach(() => { originalHome = process.env.HOME; process.env.HOME = fixture().root; });
afterEach(() => { if (originalHome === undefined) delete process.env.HOME; else process.env.HOME = originalHome; });
afterEach(() => removeDirsWithRetry(roots));
const SEARCH_VECTOR_MODEL = "history/test-model";
const SEARCH_VECTOR_DIMENSIONS = 4;
const historyConfig: CommitEmbeddingConfig = {
  provider: "openrouter", model: SEARCH_VECTOR_MODEL, dimension: SEARCH_VECTOR_DIMENSIONS,
  queryPrefix: "", documentPrefix: "", baseUrl: "https://openrouter.ai/api/v1",
};

function fixture() {
  mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(path.join(scratch, "run-"));
  roots.push(root);
  // Scratch lives inside this repository's .pi/artifacts. Mark the fixture as
  // a separate project so findProjectRoot cannot climb to the host checkout.
  mkdirSync(path.join(root, ".git"));
  mkdirSync(path.join(root, ".pi/search"), { recursive: true });
  enableSearchSources(root);
  const prefs = path.join(root, "pix-desktop.jsonc");
  const auth = path.join(root, "auth.json");
  const mapPath = path.join(root, "acp-sessions.json");
  writeFileSync(auth, JSON.stringify({ openrouter: { type: "api_key", key: "test-key-not-networked" } }));
  const indexPath = path.join(root, ".pi/search/tasks.sqlite");
  const sessionsPath = path.join(root, ".pi/search/sessions.sqlite");
  const commitsPath = path.join(root, ".pi/search/git-commits.sqlite");
  return {
    root, prefs, auth, mapPath, indexPath, sessionsPath, commitsPath,
    config: undefined as CommitEmbeddingConfig | undefined,
    configure(enabled = true) {
      this.config = enabled ? { ...historyConfig } : undefined;
    },
  };
}

test("history configuration ignores project and Desktop legacy files without altering them", async () => {
  const f = fixture();
  const embedding = { embeddingProvider: "ollama", embeddingModel: "code", knowledgeEmbeddingModel: "docs", vectorSize: 4 };
  mkdirSync(path.join(f.root, ".indexer-cli"));
  const legacy = path.join(f.root, ".indexer-cli/config.json");
  const original = JSON.stringify(embedding);
  writeFileSync(legacy, original);
  writeFileSync(path.join(f.root, ".pi/search/semantic.json"), JSON.stringify({ enabled: false, embedding }));
  writeFileSync(f.prefs, JSON.stringify({ search: { tasksSemanticEnabled: true, sessionTitlesEnabled: true } }));
  // Isolate HOME in a child so this test never consults the real user's config.
  const script = `const { loadCommitConfig } = await import(${JSON.stringify(fileURLToPath(new URL("../src/project-search/semantic-commit-provider.ts", import.meta.url)))}); console.log(JSON.stringify(await loadCommitConfig(${JSON.stringify(f.root)}) ?? null));`;
  const child = Bun.spawn([process.execPath, "-e", script], { env: { ...process.env, HOME: f.root }, stdout: "pipe", stderr: "pipe" });
  expect(await new Response(child.stdout).text()).toBe("null\n");
  expect(await child.exited).toBe(0);
  expect(readFileSync(legacy, "utf8")).toBe(original);
});

test("global plain JSON enables Tasks, Sessions and Commits with the Knowledge model, endpoint and dimensions", async () => {
  const f = fixture();
  taskDb(f.root, [{ id: "central-task", title: "Shield mechanics" }]);
  const name = "Engineering council";
  const session = { id: "central-session", path: await nativeSessionFile(f, "central-session", name), name, firstMessage: "Draft project" };
  writeFileSync(f.mapPath, JSON.stringify({ version: 1, sessions: [
    { sessionId: "acp-central", cwd: f.root, piSessionPath: session.path, title: name, namedTitle: name },
  ] }));
  writeFileSync(f.prefs, JSON.stringify({ search: { tasksSemanticEnabled: false, sessionTitlesEnabled: false } }));
  const projectConfig = path.join(f.root, ".pi/search/semantic.json");
  const legacy = JSON.stringify({ enabled: false, embedding: { embeddingProvider: "openrouter", embeddingModel: "legacy", vectorSize: 4 } });
  writeFileSync(projectConfig, legacy);
  const entry = (name: string) => JSON.stringify(fileURLToPath(new URL(`../src/project-search/${name}.ts`, import.meta.url)));
  const script = `
    import { mkdirSync, writeFileSync, existsSync } from "node:fs";
    const { cachedProjectSemantics } = await import(${entry("semantic")});
    const { syncSavedTaskVectors } = await import(${entry("semantic-task-indexer")});
    const { indexMissingSessionVectors } = await import(${entry("semantic-session-indexer")});
    const { semanticConfiguration } = await import(${entry("semantic-provider")});
    const { searchSemanticCommits } = await import(${entry("semantic-commit-indexer")});
    const root = ${JSON.stringify(f.root)};
    const candidates = { tasks: [{ id: "central-task", title: "Shield mechanics" }], sessions: [${JSON.stringify(session)}] };
    const options = { sessionMapPath: ${JSON.stringify(f.mapPath)} };
    const configPath = root + "/.config/pi/pi-tools-suite.jsonc";
    const commit = { hash: "${commitHash(501)}", shortHash: "0000000", title: "Original mechanics", author: "Author", date: "2026-10-10", message: "Original spells", paths: [] };
    const requests = [];
    globalThis.fetch = async (url, init) => {
      const body = JSON.parse(init.body);
      requests.push({ url: String(url), body, auth: init.headers.Authorization ?? null });
      return new Response(JSON.stringify({ model: body.model, embeddings: body.input.map(() => [1, 0, 0, 0, 0, 0]) }));
    };
    async function run(bootstrap = false) {
      const signal = new AbortController().signal;
      const config = bootstrap ? await semanticConfiguration(options, signal) : undefined;
      if (config) await syncSavedTaskVectors(root, undefined, options, signal, config);
      if (config) await indexMissingSessionVectors(root, candidates.sessions, undefined, options, signal, config, true);
      const histories = await cachedProjectSemantics(root, "abstract concept", candidates, signal, options);
      const commits = await searchSemanticCommits(root, [commit], "abstract concept", async () => commit.hash, signal);
      return { tasks: [...histories.tasks.keys()], sessions: [...histories.sessions.keys()], commits: commits.hits.map(hit => hit.hash), notices: [...histories.notices, ...commits.notices] };
    }
    const absent = await run();
    mkdirSync(root + "/.config/pi", { recursive: true });
    writeFileSync(configPath, '{"search":{"embedding":{"embeddingProvider":"ollama","embeddingModel":"invalid","vectorSize":0}}}');
    const invalid = await run();
    const beforeConfigured = { calls: requests.length, index: existsSync(${JSON.stringify(f.indexPath)}) };
    writeFileSync(configPath, JSON.stringify({ enabled: false, search: { embedding: { embeddingProvider: "ollama", embeddingModel: "code-model", knowledgeEmbeddingModel: "knowledge-model", vectorSize: 6, knowledgeEmbeddingQueryPrefix: "Q: ", knowledgeEmbeddingDocumentPrefix: "D: ", ollamaBaseUrl: "http://127.0.0.1:19999/custom" } } }));
    const configured = await run(true);
    const reused = await run();
    console.log(JSON.stringify({ absent, invalid, beforeConfigured, configured, reused, requests }));
  `;
  const child = Bun.spawn([process.execPath, "-e", script], {
    env: { ...process.env, HOME: f.root, PI_CODING_AGENT_DIR: path.join(f.root, ".pi/agent"), OPENROUTER_API_KEY: "" },
    stdout: "pipe", stderr: "pipe",
  });
  const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" });
  const result = JSON.parse(stdout);
  expect(result.absent).toEqual({ tasks: [], sessions: [], commits: [], notices: [] });
  expect(result.invalid).toEqual(result.absent);
  expect(result.beforeConfigured).toEqual({ calls: 0, index: false });
  expect(result.configured).toEqual({ tasks: ["central-task"], sessions: ["central-session"], commits: [commitHash(501)], notices: [] });
  expect(result.reused).toEqual(result.configured);
  expect(result.requests).toHaveLength(6);
  for (const request of result.requests) {
    expect(request.url).toBe("http://127.0.0.1:19999/custom/api/embed");
    expect(request.body.model).toBe("knowledge-model");
    expect(request.auth).toBeNull();
  }
  expect(result.requests.flatMap((request: { body: { input: string[] } }) => request.body.input)).toEqual([
    "D: Task title: Shield mechanics\nTask description: ", "D: Engineering council", "Q: abstract concept",
    "D: Original mechanics\nAuthor\nOriginal spells", "Q: abstract concept", "Q: abstract concept",
  ]);
  const db = new Database(f.indexPath, { readonly: true });
  const sessionDb = new Database(f.sessionsPath, { readonly: true });
  const commitDb = new Database(f.commitsPath, { readonly: true });
  try {
    expect(db.query("SELECT length(vector) AS bytes FROM pix_task_vectors").get()?.bytes).toBe(24);
    expect(sessionDb.query("SELECT length(vector) AS bytes FROM pix_session_vectors").get()?.bytes).toBe(24);
    expect(commitDb.query("SELECT vector FROM pix_commit_vectors").get()?.vector).toBe("[1,0,0,0,0,0]");
  } finally { db.close(); sessionDb.close(); commitDb.close(); }
  expect(readFileSync(projectConfig, "utf8")).toBe(legacy);
});

test("history OpenRouter credentials come from the shared SDK store then environment, never Desktop/project config", async () => {
  const f = fixture();
  const directory = path.join(f.root, ".config/pi");
  mkdirSync(directory, { recursive: true });
  const configPath = path.join(directory, "pi-tools-suite.jsonc");
  const original = JSON.stringify({ search: { embedding: { embeddingProvider: "openrouter", embeddingModel: "code-model", vectorSize: 4,
    knowledgeEmbeddingModel: "history/test-model", knowledgeEmbeddingQueryPrefix: "Q: ", apiKey: "ignored-config-key" } } });
  writeFileSync(configPath, original);
  const provider = fileURLToPath(new URL("../src/project-search/semantic-commit-provider.ts", import.meta.url));
  const semanticProvider = fileURLToPath(new URL("../src/project-search/semantic-provider.ts", import.meta.url));
  const authDir = path.join(f.root, "private-sdk");
  const script = `
    import { mkdirSync, writeFileSync } from "node:fs";
    const { loadCommitConfig, loadCommitKey } = await import(${JSON.stringify(provider)});
    const { embedSemanticQuery } = await import(${JSON.stringify(semanticProvider)});
    const config = await loadCommitConfig(${JSON.stringify(f.root)});
    const absent = await loadCommitKey();
    mkdirSync(${JSON.stringify(authDir)}, { recursive: true });
    writeFileSync(${JSON.stringify(path.join(authDir, "auth.json"))}, JSON.stringify({ openrouter: { type: "api_key", key: "sdk-test-key" } }));
    const sdk = await loadCommitKey();
    const requests = [];
    globalThis.fetch = async (url, init) => {
      const body = JSON.parse(init.body);
      requests.push({ url: String(url), body, auth: init.headers.Authorization });
      return new Response(JSON.stringify({ object: "list", model: body.model, data: [{ object: "embedding", index: 0, embedding: [1,0,0,0] }] }));
    };
    await embedSemanticQuery("abstract concept", sdk, new AbortController().signal, config);
    process.env.OPENROUTER_API_KEY = " env-test-key ";
    const env = await loadCommitKey();
    await embedSemanticQuery("abstract concept", env, new AbortController().signal, config);
    console.log(JSON.stringify({ absent: absent ?? null, requests }));
  `;
  const child = Bun.spawn([process.execPath, "-e", script], { env: { ...process.env, HOME: f.root,
    PI_CODING_AGENT_DIR: authDir, OPENROUTER_API_KEY: "" }, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" });
  const result = JSON.parse(stdout);
  expect(result.absent).toBeNull();
  expect(result.requests).toEqual(["sdk-test-key", "env-test-key"].map(key => ({
    url: "https://openrouter.ai/api/v1/embeddings", auth: `Bearer ${key}`,
    body: { model: "history/test-model", input: ["Q: abstract concept"], encoding_format: "float" },
  })));
  expect(readFileSync(configPath, "utf8")).toBe(original);
});

function vector(index: number): Buffer {
  const data = Buffer.alloc(SEARCH_VECTOR_DIMENSIONS * 4);
  data.writeFloatLE(1, index * 4);
  return data;
}
const queryVector = (index: number) => Array.from({ length: SEARCH_VECTOR_DIMENSIONS }, (_, i) => i === index ? 1 : 0);

function savedVectors(f: ReturnType<typeof fixture>, tasks: { id: string; title: string; description?: string; vectorIndex: number }[],
  sessions: { acpId: string; title: string; vectorIndex: number }[] = []) {
  const db = new Database(f.indexPath, { create: true });
  const sessionDb = new Database(f.sessionsPath, { create: true });
  try {
    db.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS pix_task_index_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS pix_task_documents(task_id TEXT PRIMARY KEY,content_hash TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS pix_task_vectors(content_hash TEXT PRIMARY KEY,vector BLOB NOT NULL);`);
    sessionDb.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS pix_session_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS pix_session_titles(session_id TEXT PRIMARY KEY,title TEXT NOT NULL,title_hash TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS pix_session_vectors(title_hash TEXT PRIMARY KEY,vector BLOB NOT NULL);`);
    for (const prefix of ["pix_task_index_meta", "pix_session_meta"]) {
      for (const [key, value] of [["identity", commitIdentity(f.config ?? historyConfig)], ["model", SEARCH_VECTOR_MODEL], ["dimensions", String(SEARCH_VECTOR_DIMENSIONS)], ["encoding", "float32le"]]) {
        (prefix === "pix_session_meta" ? sessionDb : db).prepare(`INSERT OR REPLACE INTO ${prefix}(key,value) VALUES(?,?)`).run(key, value);
      }
    }
    for (const task of tasks) {
      const hash = taskSemanticHash(task);
      db.prepare("INSERT OR REPLACE INTO pix_task_documents VALUES(?,?)").run(task.id, hash);
      db.prepare("INSERT OR REPLACE INTO pix_task_vectors VALUES(?,?)").run(hash, vector(task.vectorIndex));
    }
    for (const session of sessions) {
      const hash = createHash("sha256").update(session.title).digest("hex");
      sessionDb.prepare("INSERT OR REPLACE INTO pix_session_titles VALUES(?,?,?)").run(session.acpId, session.title, hash);
      sessionDb.prepare("INSERT OR REPLACE INTO pix_session_vectors VALUES(?,?)").run(hash, vector(session.vectorIndex));
    }
  } finally { db.close(); sessionDb.close(); }
}

function taskDb(root: string, rows: { id: string; title: string; description?: string }[]) {
  const db = new Database(path.join(root, ".pi/tasks.sqlite"), { create: true });
  try {
    db.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE tasks(id TEXT PRIMARY KEY,payload TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 1,position INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE attachments(hash TEXT PRIMARY KEY,name TEXT NOT NULL,size INTEGER NOT NULL);
      CREATE TABLE task_attachments(task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,hash TEXT NOT NULL REFERENCES attachments(hash),ordinal INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(task_id,hash));
      PRAGMA user_version=1;`);
    rows.forEach((row, position) => db.prepare("INSERT INTO tasks(id,payload,position) VALUES(?,?,?)").run(
      row.id, JSON.stringify({ ...row, type: "feature", status: "todo", priority: "medium",
        createdAt: "2026-10-10T00:00:00Z", updatedAt: "2026-10-10T00:00:00Z" }), position));
  } finally { db.close(); }
}

async function nativeSessionFile(f: ReturnType<typeof fixture>, nativeId: string, title: string, filename = path.join(f.root, `${nativeId}.jsonl`)): Promise<string> {
  writeFileSync(filename, [
    JSON.stringify({ type: "session", version: 3, id: nativeId, cwd: f.root, timestamp: "2026-10-10T00:00:00Z" }),
    JSON.stringify({ type: "session_info", id: `name-${nativeId}`, parentId: null, timestamp: "2026-10-10T00:00:00Z", name: title }),
  ].join("\n") + "\n");
  const { indexSessionChunks } = await import("../src/project-search/session-chunks.mjs");
  await indexSessionChunks(f.root, [{id:nativeId,path:filename}], {signal:new AbortController().signal});
  return filename;
}

test("unnamed sessions retrieve middle public messages and reuse shared vectors", async () => {
  const f = fixture(); f.configure();
  const file = path.join(f.root, "unnamed.jsonl");
  writeFileSync(file, [
    { type: "session", version: 3, id: "unnamed", cwd: f.root },
    { type: "message", id: "u", parentId: null, message: { role: "user", content: "Start" } },
    { type: "message", id: "a", parentId: "u", message: { role: "assistant", content: [{ type: "text", text: "Middle evidence" }], stopReason: "stop" } },
    { type: "message", id: "t", parentId: "a", message: { role: "toolResult", content: "PRIVATE" } },
    { type: "message", id: "v", parentId: "t", message: { role: "user", content: "No, keep rows" } },
  ].map(row => JSON.stringify(row)).join("\n") + "\n");
  const session: SessionRecord = { id: "unnamed", path: file, cwd: f.root, firstMessage: "Start" };
  const { indexSessionChunks } = await import("../src/project-search/session-chunks.mjs");
  await indexSessionChunks(f.root, [session], {signal:new AbortController().signal});
  const deps = services(f, { listSessions: async () => [session], readSession: async () => ({ firstText: "Start", finalText: "" }) });
  const local = await searchProject(f.root, { query: "keep rows", sources: ["sessions"], indexMode: "lexical" }, deps);
  expect(local.hits[0]?.snippet).toContain("keep rows");
  expect(deps.documents).toEqual([]); expect(deps.calls).toEqual([]);
  const semantic = await searchProject(f.root, { query: "conceptual redesign", sources: ["sessions"] }, deps);
  expect(semantic.hits).toEqual([]);
  expect(deps.documents).toEqual([]);
  await syncSessionChunks(f.root, [session], new AbortController().signal, deps.semantic, true);
  const indexed = await searchProject(f.root, { query: "conceptual redesign", sources: ["sessions"] }, deps);
  expect(indexed.hits[0]?.sessionId).toBe("unnamed");
  expect(deps.documents).toEqual(["Start", "Middle evidence", "No, keep rows"]);
  await searchProject(f.root, { query: "another concept", sources: ["sessions"] }, deps);
  expect(deps.documents).toHaveLength(3);
});

function services(f: ReturnType<typeof fixture>, extra: Partial<ProjectSearchServices> = {}): ProjectSearchServices & { calls: string[]; documents: string[] } {
  const calls: string[] = [];
  const documents: string[] = [];
  return {
    calls,
    listSessions: async () => [],
    semantic: {
      loadConfig: async () => f.config,
      loadKey: async () => JSON.parse(readFileSync(f.auth, "utf8")).openrouter?.key,
      sessionMapPath: f.mapPath,
      embedQuery: async (query: string) => { calls.push(query); return queryVector(0); },
      embedTasks: async (input: readonly string[]) => { documents.push(...input); return input.map(() => queryVector(0)); },
    },
    ...extra,
    documents,
  };
}

type GitRecord = { hash: string; title: string; message: string; author?: string; date?: string };

test("explicit history reset allows a changed model to rebuild without changing canonical tasks", async () => {
  const f = fixture(); f.configure();
  const task = { id: "reset-model", title: "Shield mechanics" };
  taskDb(f.root, [task]);
  const deps = services(f), options = deps.semantic!;
  const sync = () => syncSavedTaskVectors(f.root, "fake-key", options, new AbortController().signal, f.config!);
  const search = () => cachedProjectSemantics(f.root, "protective mechanics", { tasks: [task], sessions: [] }, new AbortController().signal, options);
  await sync();
  expect((await search()).tasks.get(task.id)).toBeGreaterThan(0);
  expect(deps.documents).toHaveLength(1);
  f.config = { ...historyConfig, model: "new-history-model" };
  expect((await search()).tasks.size).toBe(0);
  expect(deps.documents).toHaveLength(1);
  expect(await resetHistoryVectors(f.root, new AbortController().signal)).toBe(1);
  await sync();
  expect((await search()).tasks.get(task.id)).toBeGreaterThan(0);
  expect(deps.documents).toHaveLength(2);
  const db = new Database(path.join(f.root, ".pi/tasks.sqlite"), { readonly: true });
  try { expect(JSON.parse((db.query("SELECT payload FROM tasks").get() as { payload: string }).payload).title).toBe(task.title); }
  finally { db.close(); }
});

const commitConfig: CommitEmbeddingConfig = {
  provider: "ollama", model: "embedding-test-model", dimension: SEARCH_VECTOR_DIMENSIONS,
  queryPrefix: "search_query: ", documentPrefix: "search_document: ", baseUrl: "http://127.0.0.1:11434",
};

function gitHarness(f: ReturnType<typeof fixture>, initial: GitRecord[], config: CommitEmbeddingConfig = commitConfig) {
  let records = [...initial];
  const embedded: string[] = [];
  let embedder: (texts: readonly string[], signal: AbortSignal) => Promise<readonly (readonly number[])[]> = async inputs => {
    embedded.push(...inputs);
    return inputs.map(() => queryVector(0));
  };
  const deps = services(f, {
    git: async (_root, args) => {
      if (args[0] === "rev-parse") return records[0]?.hash + "\n";
      if (args[0] !== "log") throw Error("Unexpected Git command");
      return records.map((record, i) => [
        `PIX-PROJECT-COMMIT:${record.hash}`, record.hash.slice(0, 7), record.title, record.author ?? "Project author",
        record.date ?? "2026-10-10T00:00:00+00:00", record.message,
        `\nsrc/commit-${i}.ts`, "",
      ].join("\0")).join("");
    },
    commitSemantic: {
      loadConfig: async () => config,
      loadKey: async () => undefined,
      embed: (texts, _cfg, _key, signal) => embedder(texts, signal),
    },
  });
  return {
    deps, embedded,
    update(next: GitRecord[]) { records = [...next]; },
    embedWith(next: typeof embedder) { embedder = next; },
  };
}

function commitHash(number: number) { return number.toString(16).padStart(40, "0"); }

describe("project_search shared semantic cache", () => {
  test("query cache keys include the full configured Knowledge identity", async () => {
    const f = fixture();
    const task = { id: "cache", title: "Shield mechanics", vectorIndex: 0 };
    taskDb(f.root, [{ id: task.id, title: task.title }]);
    f.configure();
    savedVectors(f, [task]);
    const deps = services(f);
    delete deps.semantic!.embedQuery;
    const oldFetch = globalThis.fetch;
    const inputs: string[] = [];
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      inputs.push(...body.input);
      return new Response(JSON.stringify({ object: "list", model: body.model,
        data: [{ object: "embedding", index: 0, embedding: queryVector(0) }] }));
    }) as typeof fetch;
    try {
      for (let i = 0; i < 2; i++) {
        const result = await searchProject(f.root, { query: "abstract concept", sources: ["tasks"] }, deps);
        expect(result.notices).toEqual([]);
        expect(result.hits.map(hit => hit.taskId)).toEqual(["cache"]);
      }
      expect(inputs).toEqual(["abstract concept"]);
      f.config = { ...historyConfig, queryPrefix: "Different query: ", documentPrefix: "Different document: ", baseUrl: "https://example.invalid/v2" };
      // Simulate an independently produced compatible cache for the new identity.
      // Production must neither reinterpret nor convert the old cache itself.
      savedVectors(f, [task]);
      expect((await searchProject(f.root, { query: "abstract concept", sources: ["tasks"] }, deps)).hits.map(hit => hit.taskId)).toEqual(["cache"]);
      expect(inputs).toEqual(["abstract concept", "Different query: abstract concept"]);
      expect(deps.documents).toEqual([]);
    } finally { globalThis.fetch = oldFetch; }
  });

  test("legacy, unidentified and differently configured history caches fail closed without deleting paid vectors", async () => {
    for (const mode of ["legacy", "unidentified", "different"] as const) {
      const f = fixture();
      const task = { id: "paid", title: "Paid work", vectorIndex: 0 };
      const name = "Engineering council";
      const session: SessionRecord = { id: "native", path: await nativeSessionFile(f, "native", name), cwd: f.root, name, firstMessage: "Draft project" };
      taskDb(f.root, [{ id: task.id, title: task.title }]);
      writeFileSync(f.mapPath, JSON.stringify({ version: 1, sessions: [
        { sessionId: "acp", cwd: f.root, piSessionPath: session.path, title: name, namedTitle: name },
      ] }));
      f.configure();
      savedVectors(f, [task], [{ acpId: "acp", title: name, vectorIndex: 0 }]);
      for (const [filename, table] of [[f.indexPath, "pix_task_index_meta"], [f.sessionsPath, "pix_session_meta"]]) {
        const edit = new Database(filename);
        try {
          if (mode === "legacy") edit.exec(`DELETE FROM ${table} WHERE key='identity'`);
          if (mode === "unidentified") edit.exec(`DELETE FROM ${table}`);
        } finally { edit.close(); }
      }
      if (mode === "different") f.config = { ...historyConfig, documentPrefix: "changed: " };
      const deps = services(f, { listSessions: async () => [session], readSession: async () => ({ firstText: "Background", finalText: "Outcome" }) });
      const result = await searchProject(f.root, { query: "abstract concept", sources: ["tasks", "sessions"] }, deps);
      expect(result.hits).toEqual([]);
      expect(result.notices.join(" ")).toContain("incompatible");
      expect(deps.calls).toEqual([]);
      expect(deps.documents).toEqual([]);
      const db = new Database(f.indexPath, { readonly: true });
      const sessionDb = new Database(f.sessionsPath, { readonly: true });
      try {
        expect(db.query("SELECT content_hash,hex(vector) AS vector FROM pix_task_vectors").all()).toEqual([
          { content_hash: taskSemanticHash(task), vector: vector(0).toString("hex").toUpperCase() },
        ]);
        expect(sessionDb.query("SELECT title_hash,hex(vector) AS vector FROM pix_session_vectors").all()).toEqual([
          { title_hash: createHash("sha256").update(name).digest("hex"), vector: vector(0).toString("hex").toUpperCase() },
        ]);
        expect(db.query("SELECT COUNT(*) AS n FROM pix_task_documents").get()?.n).toBe(1);
        expect(sessionDb.query("SELECT COUNT(*) AS n FROM pix_session_titles").get()?.n).toBe(1);
      } finally { db.close(); sessionDb.close(); }
    }
  });

  test("full Knowledge identity changes during task/session upload discard completion and preserve prior paid work", async () => {
    const changes: Partial<CommitEmbeddingConfig>[] = [
      { model: "different-model" }, { dimension: 6 }, { queryPrefix: "query: " },
      { documentPrefix: "document: " }, { baseUrl: "https://example.invalid/api" }, { provider: "ollama" },
    ];
    for (const source of ["tasks", "sessions"] as const) for (const change of changes) {
      const f = fixture();
      f.configure();
      const task = { id: "new", title: "New work" };
      const name = "New council";
      const session: SessionRecord = { id: "native", path: await nativeSessionFile(f, "native", name), cwd: f.root, name, firstMessage: "Draft project" };
      taskDb(f.root, [task]);
      writeFileSync(f.mapPath, JSON.stringify({ version: 1, sessions: [
        { sessionId: "acp-new", cwd: f.root, piSessionPath: session.path, title: name, namedTitle: name },
      ] }));
      savedVectors(f, [{ id: "old", title: "Old paid work", vectorIndex: 0 }], [{ acpId: "acp-old", title: "Old council", vectorIndex: 0 }]);
      const deps = services(f, { listSessions: async () => [session], readSession: async () => ({ firstText: "Background", finalText: "Outcome" }) });
      let entered!: () => void, release!: () => void;
      const started = new Promise<void>(resolve => entered = resolve);
      const gate = new Promise<void>(resolve => release = resolve);
      deps.semantic!.embedTasks = async texts => { entered(); await gate; return texts.map(() => queryVector(0)); };
      const pending = source === "tasks"
        ? syncSavedTaskVectors(f.root, "fake-key", deps.semantic!, new AbortController().signal, historyConfig)
          .then(() => ({ hits: [], notices: [] as string[] }), () => ({ hits: [], notices: ["sync interrupted"] }))
        : indexMissingSessionVectors(f.root, [session], "fake-key", deps.semantic!, new AbortController().signal, historyConfig, true)
          .then(() => ({ hits: [], notices: [] as string[] }), () => ({ hits: [], notices: ["sync interrupted"] }));
      await started;
      f.config = { ...historyConfig, ...change };
      release();
      const result = await pending;
      expect(result.hits).toEqual([]);
      expect(result.notices.length).toBeGreaterThan(0);
      expect(deps.calls).toEqual([]);
      const db = new Database(f.indexPath, { readonly: true });
      const sessionDb = new Database(f.sessionsPath, { readonly: true });
      try {
        expect(db.query("SELECT COUNT(*) AS n FROM pix_task_vectors").get()?.n).toBe(1);
        expect(sessionDb.query("SELECT COUNT(*) AS n FROM pix_session_vectors").get()?.n).toBe(1);
        expect(db.query("SELECT task_id FROM pix_task_documents").all()).toEqual([{ task_id: "old" }]);
        expect(sessionDb.query("SELECT session_id FROM pix_session_titles").all()).toEqual([{ session_id: "acp-old" }]);
      } finally { db.close(); sessionDb.close(); }
    }
  });

  test("configuration changes before document uploads prevent any provider call", async () => {
    const f = fixture();
    f.configure();
    taskDb(f.root, [{ id: "volatile", title: "Volatile work" }]);
    const deps = services(f);
    let reads = 0;
    deps.semantic!.loadConfig = async () => ++reads < 3 ? historyConfig : { ...historyConfig, baseUrl: "https://example.invalid/api" };
    await expect(syncSavedTaskVectors(f.root, "fake-key", deps.semantic!, new AbortController().signal, historyConfig)).rejects.toThrow("Semantic configuration changed");
    expect(deps.documents).toEqual([]);
    expect(deps.calls).toEqual([]);
  });

  test("cancelled task/session uploads roll back late completion and release writer ownership for retry", async () => {
    for (const source of ["tasks", "sessions"] as const) {
      const f = fixture();
      f.configure();
      const task = { id: "new", title: "New work" };
      const name = "New council";
      const session = { id: "native", path: await nativeSessionFile(f, "native", name), name, firstMessage: "Draft project" };
      taskDb(f.root, [task]);
      writeFileSync(f.mapPath, JSON.stringify({ version: 1, sessions: [
        { sessionId: "acp-new", cwd: f.root, piSessionPath: session.path, title: name, namedTitle: name },
      ] }));
      savedVectors(f, [{ id: "old", title: "Old paid work", vectorIndex: 0 }], [{ acpId: "acp-old", title: "Old council", vectorIndex: 0 }]);
      const deps = services(f);
      const candidates = { tasks: source === "tasks" ? [task] : [], sessions: source === "sessions" ? [session] : [] };
      let entered!: () => void, release!: () => void;
      const started = new Promise<void>(resolve => entered = resolve);
      const gate = new Promise<void>(resolve => release = resolve);
      deps.semantic!.embedTasks = async texts => { entered(); await gate; return texts.map(() => queryVector(0)); };
      const controller = new AbortController();
      const pending = source === "tasks"
        ? syncSavedTaskVectors(f.root, "fake-key", deps.semantic!, controller.signal, historyConfig)
        : indexMissingSessionVectors(f.root, [session], "fake-key", deps.semantic!, controller.signal, historyConfig, true);
      await started;
      const failure = pending.then(() => undefined, error => error);
      controller.abort(new Error("cancelled upload"));
      release();
      expect(await failure).toMatchObject({ message: "cancelled upload" });
      const db = new Database(f.indexPath, { readonly: true });
      const sessionDb = new Database(f.sessionsPath, { readonly: true });
      try {
        expect(db.query("SELECT COUNT(*) AS n FROM pix_task_vectors").get()?.n).toBe(1);
        expect(sessionDb.query("SELECT COUNT(*) AS n FROM pix_session_vectors").get()?.n).toBe(1);
      } finally { db.close(); sessionDb.close(); }
      deps.semantic!.embedTasks = async texts => texts.map(() => queryVector(0));
      if (source === "tasks") await syncSavedTaskVectors(f.root, "fake-key", deps.semantic!, new AbortController().signal, historyConfig);
      else await indexMissingSessionVectors(f.root, [session], "fake-key", deps.semantic!, new AbortController().signal, historyConfig, true);
      const retry = await cachedProjectSemantics(f.root, "abstract concept", candidates, new AbortController().signal, deps.semantic);
      expect(retry[source].has(source === "tasks" ? task.id : session.id)).toBe(true);
      expect(retry.notices).toEqual([]);
    }
  });

  test("reuses only current task hashes and returns semantic-only hits, waiting for the query vector", async () => {
    const f = fixture();
    const tasks = [
      { id: "current", title: "Arcane mechanics", description: "Refactor spell interactions", vectorIndex: 0 },
      { id: "other", title: "Map decorations", description: "Icon assets", vectorIndex: 1 },
      { id: "changed", title: "Improved shields", description: "New objective", vectorIndex: 0 },
    ];
    taskDb(f.root, tasks.map(({ id, title, description }) => ({ id, title, description })));
    savedVectors(f, [tasks[0]!, tasks[1]!, { ...tasks[2]!, description: "Obsolete content" }]);
    f.configure();
    let resume!: () => void;
    let entered!: () => void;
    const waiting = new Promise<void>(resolve => entered = resolve);
    const held = new Promise<void>(resolve => resume = resolve);
    const deps = services(f);
    deps.semantic!.embedQuery = async query => { deps.calls.push(query); entered(); await held; return queryVector(0); };
    const pending = searchProject(f.root, { query: "conceptual redesign", sources: ["tasks"] }, deps);
    await waiting;
    let finished = false;
    void pending.then(() => { finished = true; });
    await Promise.resolve();
    expect(finished).toBe(false, "agent tool waits until semantic source finishes");
    resume();
    const result = await pending;
    expect(result.hits.map(hit => hit.id).sort()).toEqual(["tasks:current"]);
    expect(result.hits).toEqual(expect.arrayContaining([expect.objectContaining({ semantic: true, taskId: "current" })]));
    expect(deps.calls).toEqual(["conceptual redesign"]);
    expect(deps.documents).toEqual([]);
    expect(result.notices.join(" ")).toContain("1 task texts have no current cached vector");
    await syncSavedTaskVectors(f.root, "fake-key", deps.semantic!, new AbortController().signal, historyConfig);
    expect(deps.documents).toEqual(["Task title: Improved shields\nTask description: New objective"]);
    const refreshed = await searchProject(f.root, { query: "conceptual redesign", sources: ["tasks"] }, services(f));
    expect(refreshed.hits.map(hit => hit.id).sort()).toEqual(["tasks:changed", "tasks:current"]);
  });

  test("central configuration enables histories; lexical never embeds and task queries never fill missing caches", async () => {
    const f = fixture();
    taskDb(f.root, [{ id: "T", title: "Mechanics", description: "Report balance" }]);
    savedVectors(f, [{ id: "T", title: "Mechanics", description: "Report balance", vectorIndex: 0 }]);
    const deps = services(f);
    f.configure(false);
    expect((await searchProject(f.root, { query: "conceptual redesign", sources: ["tasks"] }, deps)).hits).toEqual([]);
    expect(deps.calls).toEqual([]);
    f.configure();
    expect((await searchProject(f.root, { query: "conceptual redesign", sources: ["tasks"], indexMode: "lexical" }, deps)).hits).toEqual([]);
    expect(deps.calls).toEqual([]);
    expect((await searchProject(f.root, { query: "mechanics", sources: ["tasks"], indexMode: "lexical" }, deps)).hits.map(hit => hit.taskId)).toEqual(["T"]);
    expect(deps.calls).toEqual([]);

    const second = fixture();
    second.configure();
    taskDb(second.root, [{ id: "T2", title: "Uncached objective" }]);
    const missing = services(second);
    const result = await searchProject(second.root, { query: "nonliteral concept", sources: ["tasks"] }, missing);
    expect(result.hits).toEqual([]);
    expect(missing.calls).toEqual([]);
    expect(missing.documents).toEqual([]);
    expect(existsSync(second.indexPath)).toBe(false, "task search must not initialize or fill the shared cache");
    await syncSavedTaskVectors(second.root, "fake-key", missing.semantic!, new AbortController().signal, historyConfig);
    expect((await searchProject(second.root, { query: "nonliteral concept", sources: ["tasks"] }, missing)).hits.map(hit => hit.taskId)).toEqual(["T2"]);
    expect(missing.calls).toEqual(["nonliteral concept"]);
    expect(missing.documents).toEqual(["Task title: Uncached objective\nTask description: "]);
  });

  test("only session names proven by ACP map + native listing can be semantically matched", async () => {
    const f = fixture();
    const sessions: SessionRecord[] = [
      { id: "native-good", path: path.join(f.root, "good.jsonl"), cwd: f.root,
        name: "Architecture discussion", firstMessage: "A question" },
      { id: "native-renamed", path: path.join(f.root, "renamed.jsonl"), cwd: f.root,
        name: "New task title", firstMessage: "Old question" },
      { id: "native-fallback", path: path.join(f.root, "fallback.jsonl"), cwd: f.root,
        name: "First user question", firstMessage: "First user question" },
    ];
    for (const session of sessions) await nativeSessionFile(f, session.id, session.name!, session.path);
    writeFileSync(f.mapPath, JSON.stringify({ version: 1, sessions: [
      { sessionId: "acp-good", cwd: f.root, piSessionPath: sessions[0]!.path,
        title: sessions[0]!.name, namedTitle: sessions[0]!.name },
      { sessionId: "acp-old", cwd: f.root, piSessionPath: sessions[1]!.path,
        title: "Old task title", namedTitle: "Old task title" },
      { sessionId: "acp-fallback", cwd: f.root, piSessionPath: sessions[2]!.path,
        title: sessions[2]!.name, namedTitle: sessions[2]!.name },
    ] }));
    savedVectors(f, [], [
      { acpId: "acp-good", title: "Architecture discussion", vectorIndex: 0 },
      { acpId: "acp-old", title: "Old task title", vectorIndex: 0 },
      { acpId: "acp-fallback", title: "First user question", vectorIndex: 0 },
    ]);
    f.configure();
    const deps = services(f, { listSessions: async () => sessions,
      readSession: async () => ({ firstText: "Native first", finalText: "Completed native answer" }) });
    const result = await searchProject(f.root, { query: "conceptual redesign", sources: ["sessions"] }, deps);
    expect(result.hits.map(hit => hit.id)).toEqual(["sessions:native-good"]);
    expect(result.hits[0]).toMatchObject({ semantic: true, sessionId: "native-good", sessionPath: sessions[0]!.path });
    expect(deps.calls).toEqual(["conceptual redesign"]);
    expect(JSON.stringify(result.hits)).not.toContain("Old task title");
  });

  test("tasks and saved session names share one query embedding, not two", async () => {
    const f = fixture();
    taskDb(f.root, [{ id: "task", title: "Magic overhaul" }]);
    const session: SessionRecord = { id: "native", path: path.join(f.root, "run.jsonl"), cwd: f.root,
      name: "Research laboratory", firstMessage: "First prompt" };
    await nativeSessionFile(f, session.id, session.name!, session.path);
    writeFileSync(f.mapPath, JSON.stringify({ version: 1, sessions: [
      { sessionId: "acp", cwd: f.root, piSessionPath: session.path, title: session.name, namedTitle: session.name },
    ] }));
    savedVectors(f, [{ id: "task", title: "Magic overhaul", vectorIndex: 0 }], [
      { acpId: "acp", title: "Research laboratory", vectorIndex: 0 },
    ]);
    f.configure();
    const deps = services(f, { listSessions: async () => [session],
      readSession: async () => ({ firstText: "First prompt", finalText: "Completed answer" }) });
    const result = await searchProject(f.root, { query: "conceptual redesign", sources: ["tasks", "sessions"] }, deps);
    expect(result.hits.map(hit => hit.id).sort()).toEqual(["sessions:native", "tasks:task"]);
    expect(deps.calls).toEqual(["conceptual redesign"]);
    expect(result.notices).toEqual([]);
  });

  test("stale mismatched model identity, corrupt cache or missing credential never causes a network call", async () => {
    const f = fixture();
    taskDb(f.root, [{ id: "work", title: "Magic overhaul" }]);
    savedVectors(f, [{ id: "work", title: "Magic overhaul", vectorIndex: 0 }]);
    f.configure();
    const db = new Database(f.indexPath);
    try { db.prepare("UPDATE pix_task_index_meta SET value='wrong/model' WHERE key='model'").run(); }
    finally { db.close(); }
    const deps = services(f);
    const result = await searchProject(f.root, { query: "conceptual redesign", sources: ["tasks"] }, deps);
    expect(result.hits).toEqual([]);
    expect(deps.calls).toEqual([]);
    const check = new Database(f.indexPath, { readonly: true });
    try { expect(check.prepare("SELECT value FROM pix_task_index_meta WHERE key='model'").get()?.value).toBe("wrong/model"); }
    finally { check.close(); }
    const second = fixture();
    taskDb(second.root, [{ id: "ok", title: "Magic overhaul" }]);
    savedVectors(second, [{ id: "ok", title: "Magic overhaul", vectorIndex: 0 }]);
    second.configure();
    writeFileSync(second.auth, "{}");
    const noCredential = services(second);
    expect((await searchProject(second.root, { query: "conceptual redesign", sources: ["tasks"] }, noCredential)).hits).toEqual([]);
    expect(noCredential.calls).toEqual([]);
  });

  test("broken ACP session-map JSON never hides valid task vectors or exposes unverified session names", async () => {
    const f = fixture();
    taskDb(f.root, [{ id: "task", title: "Magic overhaul" }]);
    savedVectors(f, [{ id: "task", title: "Magic overhaul", vectorIndex: 0 }]);
    f.configure();
    writeFileSync(f.mapPath, "{not JSON");
    const session: SessionRecord = { id: "native", path: await nativeSessionFile(f, "native", "Visible session"),
      cwd: f.root, name: "Visible session", firstMessage: "First question" };
    const deps = services(f, { listSessions: async () => [session],
      readSession: async () => ({ firstText: "First question", finalText: "Answer" }) });
    const result = await searchProject(f.root, { query: "conceptual redesign", sources: ["tasks", "sessions"] }, deps);
    expect(result.hits.map(hit => hit.id)).toEqual(["tasks:task"]);
    expect(deps.calls).toEqual(["conceptual redesign"]);
  });

  test("semantic-only results and lexical hits are merged by the same stable task id", async () => {
    const f = fixture();
    taskDb(f.root, [{ id: "same", title: "Magic focus" }]);
    savedVectors(f, [{ id: "same", title: "Magic focus", vectorIndex: 0 }]);
    f.configure();
    const deps = services(f);
    const result = await searchProject(f.root, { query: "magic", sources: ["tasks"] }, deps);
    expect(result.hits).toHaveLength(1);
    expect(result.hits[0]).toMatchObject({ id: "tasks:same", semantic: true });
    expect(result.hits[0]?.snippet).toContain("todo · feature · medium");
  });

  test("a task edited while the provider is computing a query cannot match its obsolete text", async () => {
    const f = fixture();
    taskDb(f.root, [{ id: "volatile", title: "Ancient build", description: "Before changes" }]);
    savedVectors(f, [{ id: "volatile", title: "Ancient build", description: "Before changes", vectorIndex: 0 }]);
    f.configure();
    let entered!: () => void;
    let resume!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { resume = resolve; });
    const deps = services(f);
    deps.semantic!.embedQuery = async query => { deps.calls.push(query); entered(); await gate; return queryVector(0); };
    const pending = searchProject(f.root, { query: "conceptual redesign", sources: ["tasks"] }, deps);
    await started;
    const db = new Database(path.join(f.root, ".pi/tasks.sqlite"));
    try {
      db.prepare("UPDATE tasks SET payload=json_set(payload,'$.description',?) WHERE id=?").run("After changes", "volatile");
    } finally { db.close(); }
    resume();
    const result = await pending;
    expect(result.hits).toEqual([]);
    expect(deps.calls).toEqual(["conceptual redesign"]);
  });

  test("renaming a session while query embedding is pending cannot publish its stale saved-title hit", async () => {
    const f = fixture();
    const nativeId = "session-change";
    const firstName = "Original research";
    const session: SessionRecord = { id: nativeId, path: await nativeSessionFile(f, nativeId, firstName),
      cwd: f.root, name: firstName, firstMessage: "First question" };
    writeFileSync(f.mapPath, JSON.stringify({ version: 1, sessions: [{
      sessionId: "acp-original", cwd: f.root, piSessionPath: session.path, title: firstName, namedTitle: firstName,
    }] }));
    savedVectors(f, [], [{ acpId: "acp-original", title: firstName, vectorIndex: 0 }]);
    f.configure();
    let entered!: () => void;
    let resume!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { resume = resolve; });
    const deps = services(f, { listSessions: async () => [session],
      readSession: async () => ({ firstText: "First question", finalText: "Original answer" }) });
    deps.semantic!.embedQuery = async query => { deps.calls.push(query); entered(); await gate; return queryVector(0); };
    const pending = searchProject(f.root, { query: "conceptual redesign", sources: ["sessions"] }, deps);
    await started;
    writeFileSync(session.path, readFileSync(session.path, "utf8") + JSON.stringify({ type: "session_info",
      id: "new-name", parentId: null, timestamp: "2026-10-10T01:00:00Z", name: "Updated research" }) + "\n");
    resume();
    expect((await pending).hits).toEqual([]);
  });

  test("removing central configuration during an in-flight embedding discards semantic results", async () => {
    const f = fixture();
    taskDb(f.root, [{ id: "task", title: "New magic" }]);
    savedVectors(f, [{ id: "task", title: "New magic", vectorIndex: 0 }]);
    f.configure();
    let entered!: () => void;
    let resume!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { resume = resolve; });
    const deps = services(f);
    deps.semantic!.embedQuery = async () => { entered(); await gate; return queryVector(0); };
    const pending = searchProject(f.root, { query: "conceptual redesign", sources: ["tasks"] }, deps);
    await started;
    f.configure(false);
    resume();
    expect((await pending).hits).toEqual([]);
  });

  test("lexical mode does not enable cached task query embeddings", async () => {
    const f = fixture();
    taskDb(f.root, [{ id: "safe", title: "New magic" }]);
    savedVectors(f, [{ id: "safe", title: "New magic", vectorIndex: 0 }]);
    f.configure();
    const deps = services(f);
    for (const indexMode of ["lexical"] as const) {
      const result = await searchProject(f.root, { query: "conceptual redesign", sources: ["tasks"], indexMode }, deps);
      expect(result.hits).toEqual([]);
    }
    expect(deps.calls).toEqual([]);
  });

  test("failed provider calls are sanitized and preserve ordinary lexical evidence", async () => {
    const f = fixture();
    taskDb(f.root, [{ id: "local", title: "Quest planning" }]);
    savedVectors(f, [{ id: "local", title: "Quest planning", vectorIndex: 0 }]);
    f.configure();
    const deps = services(f);
    deps.semantic!.embedQuery = async () => { throw new Error("Bearer SECRET_API_KEY should not appear in tool output"); };
    const result = await searchProject(f.root, { query: "quest", sources: ["tasks"] }, deps);
    expect(result.hits.map(hit => hit.id)).toEqual(["tasks:local"]);
    expect(result.notices).toEqual([expect.stringContaining("local project results remain available")]);
    expect(JSON.stringify(result)).not.toContain("SECRET_API_KEY");
  });

  test("a symlinked search-cache directory is never traversed, and no embedding is requested", async () => {
    const f = fixture();
    taskDb(f.root, [{ id: "task", title: "Magic overhaul" }]);
    savedVectors(f, [{ id: "task", title: "Magic overhaul", vectorIndex: 0 }]);
    f.configure();
    const redirect = fixture();
    const existing = path.join(f.root, ".pi/search");
        await renameWithRetry(existing, path.join(f.root, ".pi/original-search"));
    symlinkSync(path.join(redirect.root, ".pi/search"), existing);
    const deps = services(f);
    const result = await searchProject(f.root, { query: "conceptual redesign", sources: ["tasks"] }, deps);
    expect(result.hits).toEqual([]);
    expect(deps.calls).toEqual([]);
    expect(result.notices.join(" ")).toContain("local search was used");
  });

  test("actual embedding transport submits only a query and checks the configured response model", async () => {
    const original = globalThis.fetch;
    const calls: Array<{url: string; authorization: string; payload: Record<string, unknown>}> = [];
    try {
      globalThis.fetch = async (url, init) => {
        calls.push({ url: String(url), authorization: new Headers(init?.headers).get("authorization") ?? "",
          payload: JSON.parse(String(init?.body)) as Record<string, unknown> });
        return new Response(JSON.stringify({ object: "list", model: SEARCH_VECTOR_MODEL,
          data: [{ object: "embedding", index: 0, embedding: queryVector(0) }] }),
        { headers: { "content-type": "application/json" } });
      };
      const actual = await embedSemanticQuery("conceptual redesign", "fake-key", new AbortController().signal, historyConfig);
      expect(actual).toEqual(queryVector(0));
      expect(calls).toEqual([{
        url: "https://openrouter.ai/api/v1/embeddings",
        authorization: "Bearer fake-key",
        payload: { model: SEARCH_VECTOR_MODEL, input: ["conceptual redesign"], encoding_format: "float" },
      }]);
    } finally { globalThis.fetch = original; }
  });

  test("configured saved-task catch-up creates vectors once and reindexes only changed semantic text without deleting paid vectors", async () => {
    const f = fixture();
    taskDb(f.root, [{ id: "work", title: "Shield tactics", description: "Initial armor" }]);
    f.configure();
    const deps = services(f);
    const sync = () => syncSavedTaskVectors(f.root, "fake-key", deps.semantic!, new AbortController().signal, historyConfig);
    await sync();
    let result = await searchProject(f.root, { query: "conceptual redesign", sources: ["tasks"] }, deps);
    expect(result.hits.map(hit => hit.taskId)).toEqual(["work"]);
    expect(deps.documents).toEqual(["Task title: Shield tactics\nTask description: Initial armor"]);
    expect(f.indexPath && existsSync(f.indexPath)).toBe(true);
    const first = new Database(f.indexPath, { readonly: true });
    try {
      expect(first.query("SELECT COUNT(*) AS n FROM pix_task_vectors").get()?.n).toBe(1);
      expect(first.query("SELECT COUNT(*) AS n FROM pix_task_documents").get()?.n).toBe(1);
    } finally { first.close(); }
    const db = new Database(path.join(f.root, ".pi/tasks.sqlite"));
    try {
      db.prepare("UPDATE tasks SET payload=json_set(payload,'$.priority','high','$.modelRef','provider/new:high') WHERE id='work'").run();
    } finally { db.close(); }
    await sync();
    result = await searchProject(f.root, { query: "conceptual redesign", sources: ["tasks"] }, deps);
    expect(result.hits.map(hit => hit.taskId)).toEqual(["work"]);
    expect(deps.documents).toHaveLength(1);
    const changed = new Database(path.join(f.root, ".pi/tasks.sqlite"));
    try { changed.prepare("UPDATE tasks SET payload=json_set(payload,'$.description','Revised armor') WHERE id='work'").run(); }
    finally { changed.close(); }
    await sync();
    result = await searchProject(f.root, { query: "conceptual redesign", sources: ["tasks"] }, deps);
    expect(result.hits.map(hit => hit.taskId)).toEqual(["work"]);
    expect(deps.documents).toEqual([
      "Task title: Shield tactics\nTask description: Initial armor",
      "Task title: Shield tactics\nTask description: Revised armor",
    ]);
    const final = new Database(f.indexPath, { readonly: true });
    try {
      expect(final.query("SELECT COUNT(*) AS n FROM pix_task_vectors").get()?.n).toBe(2);
      expect(final.query("SELECT COUNT(*) AS n FROM pix_task_documents").get()?.n).toBe(1);
    } finally { final.close(); }
  });

  test("deleting the final task reconciles the semantic cache without new paid work", async () => {
    const f = fixture();
    taskDb(f.root, [{ id: "last", title: "Deleted objective" }]);
    f.configure();
    const deps = services(f);
    await syncSavedTaskVectors(f.root, "fake-key", deps.semantic!, new AbortController().signal, historyConfig);
    await searchProject(f.root, { query: "conceptual redesign", sources: ["tasks"] }, deps);
    const db = new Database(path.join(f.root, ".pi/tasks.sqlite"));
    try { db.prepare("DELETE FROM tasks WHERE id='last'").run(); }
    finally { db.close(); }
    await syncSavedTaskVectors(f.root, "fake-key", deps.semantic!, new AbortController().signal, historyConfig);
    const after = await searchProject(f.root, { query: "conceptual redesign", sources: ["tasks"] }, deps);
    expect(after.hits).toEqual([]);
    expect(deps.documents).toHaveLength(1);
    const index = new Database(f.indexPath, { readonly: true });
    try {
      expect(index.query("SELECT COUNT(*) AS n FROM pix_task_documents").get()?.n).toBe(0);
      expect(index.query("SELECT COUNT(*) AS n FROM pix_task_vectors").get()?.n).toBe(1);
    } finally { index.close(); }
  });

  test("unsafe task storage cannot authorize deleting a previously paid semantic cache", async () => {
    const f = fixture();
    taskDb(f.root, [{ id: "safe", title: "Canonical work" }]);
    f.configure();
    const deps = services(f);
    await syncSavedTaskVectors(f.root, "fake-key", deps.semantic!, new AbortController().signal, historyConfig);
    await searchProject(f.root, { query: "conceptual redesign", sources: ["tasks"] }, deps);
    const db = path.join(f.root, ".pi/tasks.sqlite");
    const alias = path.join(f.root, "database-hardlink-alias");
    const { linkSync, unlinkSync } = await import("node:fs");
    linkSync(db, alias);
    try {
      await expect(syncSavedTaskVectors(f.root, "fake-key", deps.semantic!, new AbortController().signal, historyConfig)).rejects.toThrow("Unsafe task database");
      const result = await searchProject(f.root, { query: "conceptual redesign", sources: ["tasks"] }, deps);
      expect(result.hits).toEqual([]);
      expect(result.notices.join(" ")).toContain("invalid or unsafe SQLite");
      const index = new Database(f.indexPath, { readonly: true });
      try { expect(index.query("SELECT COUNT(*) AS n FROM pix_task_vectors").get()?.n).toBe(1); }
      finally { index.close(); }
    } finally { unlinkSync(alias); }
  });

  test("concurrent saved-task catch-ups share the SQLite writer lock and never pay twice for one task hash", async () => {
    const f = fixture();
    taskDb(f.root, [{ id: "shared", title: "Realtime magic" }]);
    f.configure();
    const first = services(f), second = services(f);
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>(resolve => entered = resolve);
    const gate = new Promise<void>(resolve => release = resolve);
    first.semantic!.embedTasks = async texts => { first.documents.push(...texts); entered(); await gate; return texts.map(() => queryVector(0)); };
    const a = syncSavedTaskVectors(f.root, "fake-key", first.semantic!, new AbortController().signal, historyConfig);
    await started;
    const b = syncSavedTaskVectors(f.root, "fake-key", second.semantic!, new AbortController().signal, historyConfig);
    await new Promise(resolve => setTimeout(resolve, 50));
    release();
    await Promise.all([a, b]);
    const [aResult, bResult] = await Promise.all([
      searchProject(f.root, { query: "conceptual redesign", sources: ["tasks"] }, first),
      searchProject(f.root, { query: "conceptual redesign", sources: ["tasks"] }, second),
    ]);
    expect(aResult.hits.map(hit => hit.taskId)).toEqual(["shared"]);
    expect(bResult.hits.map(hit => hit.taskId)).toEqual(["shared"]);
    expect([...first.documents, ...second.documents]).toHaveLength(1);
    expect([...first.calls, ...second.calls]).toHaveLength(2);
  });

  test("removed configuration rolls back pending task vectors; changed semantic text catches up without stale publication", async () => {
    for (const outcome of ["revoke", "edit"] as const) {
      const f = fixture();
      taskDb(f.root, [{ id: "volatile", title: "Volatile idea" }]);
      f.configure();
      const deps = services(f);
      let entered!: () => void, release!: () => void;
      const started = new Promise<void>(resolve => entered = resolve);
      const gate = new Promise<void>(resolve => release = resolve);
      deps.semantic!.embedTasks = async texts => { deps.documents.push(...texts); entered(); await gate; return texts.map(() => queryVector(0)); };
      const pending = syncSavedTaskVectors(f.root, "fake-key", deps.semantic!, new AbortController().signal, historyConfig)
        .then(() => undefined, error => error);
      await started;
      if (outcome === "revoke") f.configure(false);
      else {
        const db = new Database(path.join(f.root, ".pi/tasks.sqlite"));
        try { db.prepare("UPDATE tasks SET payload=json_set(payload,'$.title','A completely changed idea') WHERE id='volatile'").run(); }
        finally { db.close(); }
      }
      release();
      const result = await pending;
      if (outcome === "revoke") expect(result).toBeInstanceOf(Error);
      else expect(result).toBeUndefined();
      const index = new Database(f.indexPath, { readonly: true });
      try {
        const exists = index.query("SELECT 1 AS present FROM sqlite_master WHERE type='table' AND name='pix_task_vectors'").get();
        if (exists) expect(index.query("SELECT COUNT(*) AS n FROM pix_task_vectors").get()?.n).toBe(outcome === "edit" ? 1 : 0);
        if (outcome === "edit") expect(index.query("SELECT content_hash FROM pix_task_documents").get()?.content_hash).toBe(
          taskSemanticHash({ id: "volatile", title: "A completely changed idea" }));
      }
      finally { index.close(); }
    }
  });

  test("saved session title search reads cache only, skips first-message fallbacks and respects renames", async () => {
    const f = fixture();
    const name = "Engineering council";
    const session: SessionRecord = { id: "native", path: await nativeSessionFile(f, "native", name),
      cwd: f.root, name, firstMessage: "Draft project" };
    const fallback: SessionRecord = { id: "fallback", path: await nativeSessionFile(f, "fallback", "First prompt"),
      cwd: f.root, name: "First prompt", firstMessage: "First prompt" };
    writeFileSync(f.mapPath, JSON.stringify({ version: 1, sessions: [
      { sessionId: "acp", cwd: f.root, piSessionPath: session.path, title: name, namedTitle: name },
      { sessionId: "acp-fallback", cwd: f.root, piSessionPath: fallback.path, title: "First prompt", namedTitle: "First prompt" },
    ] }));
    f.configure();
    const deps = services(f, { listSessions: async () => [session, fallback],
      readSession: async () => ({ firstText: "Background", finalText: "Agent result" }) });
    let result = await searchProject(f.root, { query: "conceptual redesign", sources: ["sessions"] }, deps);
    expect(result.hits).toEqual([]);
    expect(deps.documents).toEqual([]);
    await indexMissingSessionVectors(f.root, [session, fallback], "fake-key", deps.semantic!, new AbortController().signal, historyConfig, true);
    result = await searchProject(f.root, { query: "conceptual redesign", sources: ["sessions"] }, deps);
    expect(result.hits.map(hit => hit.sessionId)).toEqual(["native"]);
    expect(deps.documents).toEqual([name]);
    const index = new Database(f.sessionsPath, { readonly: true });
    try {
      expect(index.query("SELECT session_id,title FROM pix_session_titles").all()).toEqual([{ session_id: "acp", title: name }]);
    } finally { index.close(); }
    await searchProject(f.root, { query: "conceptual redesign", sources: ["sessions"] }, deps);
    expect(deps.documents).toEqual([name]);
    const revisedName = "Revised engineering council";
    writeFileSync(session.path, readFileSync(session.path, "utf8") + JSON.stringify({ type: "session_info", id: "rename", parentId: null,
      timestamp: "2026-10-10T02:00:00Z", name: revisedName }) + "\n");
    session.name = revisedName;
    writeFileSync(f.mapPath, JSON.stringify({ version: 1, sessions: [
      { sessionId: "acp", cwd: f.root, piSessionPath: session.path, title: revisedName, namedTitle: revisedName },
    ] }));
    result = await searchProject(f.root, { query: "conceptual redesign", sources: ["sessions"] }, deps);
    expect(result.hits).toEqual([]);
    expect(deps.documents).toEqual([name]);
    const { indexSessionChunks } = await import("../src/project-search/session-chunks.mjs");
    await indexSessionChunks(f.root, [session], {signal:new AbortController().signal});
    await indexMissingSessionVectors(f.root, [session], "fake-key", deps.semantic!, new AbortController().signal, historyConfig, true);
    result = await searchProject(f.root, { query: "conceptual redesign", sources: ["sessions"] }, deps);
    expect(result.hits.map(hit => hit.sessionId)).toEqual(["native"]);
    expect(deps.documents).toEqual([name, revisedName]);
    const again = new Database(f.sessionsPath, { readonly: true });
    try {
      expect(again.query("SELECT COUNT(*) AS n FROM pix_session_vectors").get()?.n).toBe(2);
      expect(again.query("SELECT title FROM pix_session_titles WHERE session_id='acp'").get()?.title).toBe(revisedName);
    } finally { again.close(); }
  });

  test("a 260-task backlog drains at startup rather than requiring repeated agent searches", { timeout: 20_000 }, async () => {
    const f = fixture();
    taskDb(f.root, Array.from({ length: 260 }, (_, index) => ({ id: `task-${index}`, title: `Task subject ${index}` })));
    f.configure();
    const deps = services(f);
    await syncSavedTaskVectors(f.root, "fake-key", deps.semantic!, new AbortController().signal, historyConfig);
    const first = await searchProject(f.root, { query: "conceptual redesign", sources: ["tasks"], limit: 10 }, deps);
    expect(first.hits).toHaveLength(10);
    expect(deps.documents).toHaveLength(260);
    expect(first.notices).toEqual([]);
    const second = await searchProject(f.root, { query: "conceptual redesign", sources: ["tasks"], limit: 10 }, deps);
    expect(second.hits).toHaveLength(10);
    expect(deps.documents).toHaveLength(260);
    expect(second.notices).toEqual([]);
    const index = new Database(f.indexPath, { readonly: true });
    try { expect(index.query("SELECT COUNT(*) AS n FROM pix_task_vectors").get()?.n).toBe(260); }
    finally { index.close(); }
  });

  test("explicit task search without a shared provider credential stays local and does not create an index", async () => {
    const f = fixture();
    taskDb(f.root, [{ id: "hidden", title: "Hidden plans" }]);
    f.configure();
    writeFileSync(f.auth, "{}");
    const deps = services(f);
    const result = await searchProject(f.root, { query: "abstract topic", sources: ["tasks"] }, deps);
    expect(result.hits).toEqual([]);
    expect(deps.documents).toEqual([]);
    expect(deps.calls).toEqual([]);
    expect(existsSync(f.indexPath)).toBe(false);
  });

  test("commit search creates missing vectors with the configured Knowledge identity and reuses them", async () => {
    const f = fixture();
    const commit = { hash: commitHash(42), title: "Magic rewrite", message: "Implement nested spell improvements" };
    const git = gitHarness(f, [commit]);
    const result = await searchProject(f.root, { query: "conceptual redesign", sources: ["commits"] }, git.deps);
    expect(result.hits.map(hit => hit.hash)).toEqual([commit.hash]);
    expect(result.hits[0]).toMatchObject({ semantic: true });
    expect(git.embedded).toEqual([
      `search_document: ${commit.title}\nProject author\n${commit.message}`,
      "search_query: conceptual redesign",
    ]);
    const db = new Database(f.commitsPath, { readonly: true });
    try {
      expect(db.query("SELECT value FROM pix_commit_meta WHERE key='identity'").get()?.value).toBe(commitIdentity(commitConfig));
      expect(db.query("SELECT COUNT(*) AS n FROM pix_commit_vectors").get()?.n).toBe(1);
      expect(db.query("SELECT COUNT(*) AS n FROM pix_commit_documents").get()?.n).toBe(1);
      const row = db.query("SELECT metadata,message FROM pix_commit_documents").get()!;
      expect(row.message).toBe(commit.message);
      expect(JSON.parse(row.metadata as string).hash).toBe(commit.hash);
    } finally { db.close(); }
    const next = await searchProject(f.root, { query: "conceptual redesign", sources: ["commits"] }, git.deps);
    expect(next.hits.map(hit => hit.hash)).toEqual([commit.hash]);
    expect(git.embedded.filter(item => item.startsWith("search_document:"))).toHaveLength(1);
  });

  test("a new HEAD embeds only new reachable commits, and a rewritten branch never returns old commits", async () => {
    const f = fixture();
    const old = { hash: commitHash(13), title: "Original spells", message: "Initial research" };
    const current = { hash: commitHash(14), title: "Current spells", message: "Recent magical revision" };
    const git = gitHarness(f, [old]);
    await searchProject(f.root, { query: "abstract concept", sources: ["commits"] }, git.deps);
    git.update([current, old]);
    const result = await searchProject(f.root, { query: "abstract concept", sources: ["commits"] }, git.deps);
    expect(result.hits.map(hit => hit.hash).sort()).toEqual([current.hash, old.hash].sort());
    expect(git.embedded.filter(item => item.startsWith("search_document:"))).toHaveLength(2);
    git.update([current]);
    const rewritten = await searchProject(f.root, { query: "abstract concept", sources: ["commits"] }, git.deps);
    expect(rewritten.hits.map(hit => hit.hash)).toEqual([current.hash]);
    expect(git.embedded.filter(item => item.startsWith("search_document:"))).toHaveLength(2);
  });

  test("Git HEAD movement during document or query embedding cannot publish stale semantic commits", async () => {
    for (const moment of ["document", "query"] as const) {
      const f = fixture();
      const source = { hash: commitHash(71), title: "Original commit", message: "Original message" };
      const updated = { hash: commitHash(72), title: "Updated commit", message: "New message" };
      const git = gitHarness(f, [source]);
      let entered!: () => void, release!: () => void;
      const started = new Promise<void>(resolve => entered = resolve);
      const gate = new Promise<void>(resolve => release = resolve);
      git.embedWith(async inputs => {
        git.embedded.push(...inputs);
        if (inputs.some(value => value.startsWith(moment === "document" ? "search_document:" : "search_query:"))) {
          entered(); await gate;
        }
        return inputs.map(() => queryVector(0));
      });
      const pending = searchProject(f.root, { query: "conceptual redesign", sources: ["commits"] }, git.deps);
      await started;
      git.update([updated]);
      release();
      const result = await pending;
      expect(result.hits).toEqual([]);
      if (moment === "document") {
        const db = new Database(f.commitsPath, { readonly: true });
        try {
          const exists = db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='pix_commit_vectors'").get();
          if (exists) expect(db.query("SELECT COUNT(*) AS n FROM pix_commit_vectors").get()?.n).toBe(0);
        } finally { db.close(); }
      }
    }
  });

  test("changing the central embedding model while a commit query is in flight discards stale ranking", async () => {
    const f = fixture();
    const git = gitHarness(f, [{ hash: commitHash(91), title: "Original knowledge", message: "Technical notes" }]);
    let model = commitConfig;
    git.deps.commitSemantic!.loadConfig = async () => model;
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    git.embedWith(async inputs => {
      git.embedded.push(...inputs);
      if (inputs.some(value => value.startsWith("search_query:"))) { entered(); await gate; }
      return inputs.map(() => queryVector(0));
    });
    const pending = searchProject(f.root, { query: "conceptual redesign", sources: ["commits"] }, git.deps);
    await started;
    model = { ...commitConfig, model: "different-embedding-model" };
    release();
    const result = await pending;
    expect(result.hits).toEqual([]);
    expect(result.notices.join(" ")).toContain("configuration changed");
  });

  test("commit configuration changes before/after document upload cannot publish or replace paid vectors", async () => {
    for (const moment of ["before", "during"] as const) {
      const f = fixture();
      const old = { hash: commitHash(601), title: "Old paid work", message: "Immutable notes" };
      const next = { hash: commitHash(602), title: "New work", message: "Immutable research" };
      const git = gitHarness(f, [old]);
      await searchProject(f.root, { query: "abstract concept", sources: ["commits"] }, git.deps);
      const read = new Database(f.commitsPath, { readonly: true });
      let vectors: unknown[];
      try { vectors = read.query("SELECT hash,vector FROM pix_commit_vectors").all(); }
      finally { read.close(); }
      git.update([next, old]);
      git.embedded.splice(0);
      let config = commitConfig, reads = 0;
      git.deps.commitSemantic!.loadConfig = async () => {
        if (moment === "before" && ++reads === 2) config = { ...commitConfig, documentPrefix: "changed: " };
        return config;
      };
      if (moment === "during") git.embedWith(async inputs => {
        git.embedded.push(...inputs);
        config = { ...commitConfig, baseUrl: "http://127.0.0.1:19999" };
        return inputs.map(() => queryVector(0));
      });
      const result = await searchProject(f.root, { query: "abstract concept", sources: ["commits"] }, git.deps);
      expect(result.hits).toEqual([]);
      expect(result.notices.length).toBeGreaterThan(0);
      expect(git.embedded).toHaveLength(moment === "before" ? 0 : 1);
      const db = new Database(f.commitsPath, { readonly: true });
      try {
        expect(db.query("SELECT hash,vector FROM pix_commit_vectors").all()).toEqual(vectors!);
        expect(db.query("SELECT hash FROM pix_commit_documents").all()).toEqual([{ hash: old.hash }]);
      } finally { db.close(); }
    }
  });

  test("incompatible or unidentified paid commit caches stay intact and never trigger uploads", async () => {
    for (const change of ["identity", "missing", "corrupt"] as const) {
      const f = fixture();
      const git = gitHarness(f, [{ hash: commitHash(701), title: "Original work", message: "Immutable notes" }]);
      await searchProject(f.root, { query: "abstract concept", sources: ["commits"] }, git.deps);
      const edit = new Database(f.commitsPath);
      let vectors: unknown[];
      try {
        if (change === "missing") edit.exec("DELETE FROM pix_commit_meta");
        if (change === "corrupt") edit.exec("UPDATE pix_commit_vectors SET vector='[1,0]'");
        vectors = edit.query("SELECT hash,vector FROM pix_commit_vectors").all();
      } finally { edit.close(); }
      if (change === "identity") git.deps.commitSemantic!.loadConfig = async () => ({ ...commitConfig, queryPrefix: "changed: " });
      git.embedded.splice(0);
      const result = await searchProject(f.root, { query: "abstract concept", sources: ["commits"] }, git.deps);
      expect(result.hits).toEqual([]);
      expect(result.notices.join(" ")).toContain("indexing unavailable");
      expect(git.embedded).toEqual([]);
      const db = new Database(f.commitsPath, { readonly: true });
      try { expect(db.query("SELECT hash,vector FROM pix_commit_vectors").all()).toEqual(vectors!); }
      finally { db.close(); }
    }
  });

  test("commit HEAD awaits cannot open a configuration race before upload, after upload or before ranking", async () => {
    for (const moment of ["before-document", "after-document", "after-query"] as const) {
      const f = fixture();
      const old = { hash: commitHash(801), shortHash: "0000000", title: "Paid work", author: "Author", date: "2026-10-10", message: "Immutable notes", paths: [] };
      const next = { ...old, hash: commitHash(802), title: "New work" };
      const signal = new AbortController().signal;
      const services = { loadConfig: async () => commitConfig, embed: async (inputs: readonly string[]) => inputs.map(() => queryVector(0)) };
      await searchSemanticCommits(f.root, [old], "abstract concept", async () => old.hash, signal, services);
      const read = new Database(f.commitsPath, { readonly: true });
      let paid: unknown[];
      try { paid = read.query("SELECT hash,vector FROM pix_commit_vectors").all(); }
      finally { read.close(); }
      let config = commitConfig, headReads = 0, documentUploaded = false, queryUploaded = false;
      const records = moment === "after-query" ? [old] : [next, old];
      const result = await searchSemanticCommits(f.root, records, "abstract concept", async () => {
        headReads++;
        if ((moment === "before-document" && headReads === 2)
          || (moment === "after-document" && documentUploaded)
          || (moment === "after-query" && queryUploaded)) config = { ...commitConfig, queryPrefix: "changed: " };
        return records[0]!.hash;
      }, signal, {
        loadConfig: async () => config,
        embed: async inputs => {
          if (inputs[0]!.startsWith(commitConfig.queryPrefix)) queryUploaded = true;
          else documentUploaded = true;
          return inputs.map(() => queryVector(0));
        },
      });
      expect(result.hits).toEqual([]);
      expect(documentUploaded).toBe(moment === "after-document");
      expect(queryUploaded).toBe(moment === "after-query");
      const db = new Database(f.commitsPath, { readonly: true });
      try { expect(db.query("SELECT hash,vector FROM pix_commit_vectors").all()).toEqual(paid!); }
      finally { db.close(); }
    }
  });

  test("commit semantic requests respect lexical mode and saved embedding configuration", async () => {
    const f = fixture();
    const commit = { hash: commitHash(81), title: "Project organization", message: "Semantic plans" };
    const git = gitHarness(f, [commit]);
    const lexical = await searchProject(f.root, { query: "nonliteral concept", sources: ["commits"], indexMode: "lexical" }, git.deps);
    expect(lexical.hits).toEqual([]);
    expect(git.embedded).toEqual([]);
    expect(existsSync(f.indexPath)).toBe(false);
    const local = await searchProject(f.root, { query: "project", sources: ["commits"], indexMode: "lexical" }, git.deps);
    expect(local.hits.map(hit => hit.hash)).toEqual([commit.hash]);
    git.deps.commitSemantic!.loadConfig = async () => undefined;
    const noConfig = await searchProject(f.root, { query: "nonliteral concept", sources: ["commits"] }, git.deps);
    expect(noConfig.hits).toEqual([]);
    expect(git.embedded).toEqual([]);
  });
});
