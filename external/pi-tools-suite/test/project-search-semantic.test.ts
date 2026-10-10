import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Database } from "bun:sqlite";
import { searchProject, type ProjectSearchServices, type SessionRecord } from "../src/project-search/engine.js";
import { SEARCH_VECTOR_DIMENSIONS, SEARCH_VECTOR_MODEL } from "../src/project-search/semantic-provider.js";
import { taskSemanticHash } from "../src/project-search/semantic-cache.js";
import { embedSemanticQuery } from "../src/project-search/semantic-provider.js";
import { commitIdentity, type CommitEmbeddingConfig } from "../src/project-search/semantic-commit-provider.js";
import { SEARCH_EMBEDDING_MODEL } from "../../../acp/src/search/contract.js";
import { EMBEDDING_DIMENSIONS } from "../../../acp/src/search/embeddings.js";
import { removeDirsWithRetry, renameWithRetry } from "./support/fs-retry.js";

const scratch = fileURLToPath(new URL("../../../.pi/artifacts/project-search-semantic-tests/", import.meta.url));
const roots: string[] = [];
afterEach(() => removeDirsWithRetry(roots));

function fixture() {
  mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(path.join(scratch, "run-"));
  roots.push(root);
  // Scratch lives inside this repository's .pi/artifacts. Mark the fixture as
  // a separate project so findProjectRoot cannot climb to the host checkout.
  mkdirSync(path.join(root, ".git"));
  mkdirSync(path.join(root, ".pi/search"), { recursive: true });
  const prefs = path.join(root, "pix-desktop.jsonc");
  const auth = path.join(root, "auth.json");
  const mapPath = path.join(root, "acp-sessions.json");
  writeFileSync(auth, JSON.stringify({ openrouter: { type: "api_key", key: "test-key-not-networked" } }));
  const indexPath = path.join(root, ".pi/search/index.sqlite");
  return {
    root, prefs, auth, mapPath, indexPath,
    consent(tasks = false, sessions = false) {
      writeFileSync(prefs, `{\n // Opt in individually.\n "search": { "tasksSemanticEnabled": ${tasks}, "sessionTitlesEnabled": ${sessions} }\n}`);
    },
  };
}

function vector(index: number): Buffer {
  const data = Buffer.alloc(SEARCH_VECTOR_DIMENSIONS * 4);
  data.writeFloatLE(1, index * 4);
  return data;
}
const queryVector = (index: number) => Array.from({ length: SEARCH_VECTOR_DIMENSIONS }, (_, i) => i === index ? 1 : 0);

function savedVectors(f: ReturnType<typeof fixture>, tasks: { id: string; title: string; description?: string; vectorIndex: number }[],
  sessions: { acpId: string; title: string; vectorIndex: number }[] = []) {
  const db = new Database(f.indexPath, { create: true });
  try {
    db.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS pix_task_index_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS pix_task_documents(task_id TEXT PRIMARY KEY,content_hash TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS pix_task_vectors(content_hash TEXT PRIMARY KEY,vector BLOB NOT NULL);
      CREATE TABLE IF NOT EXISTS pix_session_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS pix_session_titles(session_id TEXT PRIMARY KEY,title TEXT NOT NULL,title_hash TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS pix_session_vectors(title_hash TEXT PRIMARY KEY,vector BLOB NOT NULL);`);
    for (const prefix of ["pix_task_index_meta", "pix_session_meta"]) {
      for (const [key, value] of [["model", SEARCH_VECTOR_MODEL], ["dimensions", String(SEARCH_VECTOR_DIMENSIONS)], ["encoding", "float32le"]]) {
        db.prepare(`INSERT OR REPLACE INTO ${prefix}(key,value) VALUES(?,?)`).run(key, value);
      }
    }
    for (const task of tasks) {
      const hash = taskSemanticHash(task);
      db.prepare("INSERT OR REPLACE INTO pix_task_documents VALUES(?,?)").run(task.id, hash);
      db.prepare("INSERT OR REPLACE INTO pix_task_vectors VALUES(?,?)").run(hash, vector(task.vectorIndex));
    }
    for (const session of sessions) {
      const hash = createHash("sha256").update(session.title).digest("hex");
      db.prepare("INSERT OR REPLACE INTO pix_session_titles VALUES(?,?,?)").run(session.acpId, session.title, hash);
      db.prepare("INSERT OR REPLACE INTO pix_session_vectors VALUES(?,?)").run(hash, vector(session.vectorIndex));
    }
  } finally { db.close(); }
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

function nativeSessionFile(f: ReturnType<typeof fixture>, nativeId: string, title: string, filename = path.join(f.root, `${nativeId}.jsonl`)): string {
  writeFileSync(filename, [
    JSON.stringify({ type: "session", version: 3, id: nativeId, cwd: f.root, timestamp: "2026-10-10T00:00:00Z" }),
    JSON.stringify({ type: "session_info", id: `name-${nativeId}`, parentId: null, timestamp: "2026-10-10T00:00:00Z", name: title }),
  ].join("\n") + "\n");
  return filename;
}

function services(f: ReturnType<typeof fixture>, extra: Partial<ProjectSearchServices> = {}): ProjectSearchServices & { calls: string[]; documents: string[] } {
  const calls: string[] = [];
  const documents: string[] = [];
  return {
    calls,
    exec: async () => { throw Error("IDX may not be initialized or contacted by this test"); },
    indexed: () => false,
    listSessions: async () => [],
    semantic: {
      consentPath: f.prefs,
      authPath: f.auth,
      sessionMapPath: f.mapPath,
      embedQuery: async (query: string) => { calls.push(query); return queryVector(0); },
      embedTasks: async (input: readonly string[]) => { documents.push(...input); return input.map(() => queryVector(0)); },
    },
    ...extra,
    documents,
  };
}

type GitRecord = { hash: string; title: string; message: string; author?: string; date?: string };

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
  test("the independent TUI reader uses exactly the same vector model and dimensions as ACP", () => {
    expect(SEARCH_VECTOR_MODEL).toBe(SEARCH_EMBEDDING_MODEL);
    expect(SEARCH_VECTOR_DIMENSIONS).toBe(EMBEDDING_DIMENSIONS);
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
    f.consent(true);
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
    expect(result.hits.map(hit => hit.id).sort()).toEqual(["tasks:changed", "tasks:current"]);
    expect(result.hits).toEqual(expect.arrayContaining([expect.objectContaining({ semantic: true, taskId: "current" })]));
    expect(deps.calls).toEqual(["conceptual redesign"]);
    expect(deps.documents).toEqual(["Task title: Improved shields\nTask description: New objective"]);
    expect(result.notices).toEqual([]);
  });

  test("TUI and Desktop honor independent opt-ins; lexical mode never embeds and missing caches are built on demand", async () => {
    const f = fixture();
    taskDb(f.root, [{ id: "T", title: "Mechanics", description: "Report balance" }]);
    savedVectors(f, [{ id: "T", title: "Mechanics", description: "Report balance", vectorIndex: 0 }]);
    const deps = services(f);
    f.consent(false);
    expect((await searchProject(f.root, { query: "conceptual redesign", sources: ["tasks"] }, deps)).hits).toEqual([]);
    expect(deps.calls).toEqual([]);
    f.consent(true);
    expect((await searchProject(f.root, { query: "conceptual redesign", sources: ["tasks"], indexMode: "lexical" }, deps)).hits).toEqual([]);
    expect(deps.calls).toEqual([]);
    expect((await searchProject(f.root, { query: "mechanics", sources: ["tasks"], indexMode: "lexical" }, deps)).hits.map(hit => hit.taskId)).toEqual(["T"]);
    expect(deps.calls).toEqual([]);

    const second = fixture();
    second.consent(true);
    taskDb(second.root, [{ id: "T2", title: "Uncached objective" }]);
    const missing = services(second);
    const result = await searchProject(second.root, { query: "nonliteral concept", sources: ["tasks"] }, missing);
    expect(result.hits.map(hit => hit.taskId)).toEqual(["T2"]);
    expect(missing.calls).toEqual(["nonliteral concept"]);
    expect(missing.documents).toEqual(["Task title: Uncached objective\nTask description: "]);
    expect(existsSync(second.indexPath)).toBe(true, "explicit opted-in task search initializes the shared cache");
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
    for (const session of sessions) nativeSessionFile(f, session.id, session.name!, session.path);
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
    f.consent(false, true);
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
    writeFileSync(session.path, [
      JSON.stringify({ type: "session", version: 3, id: "native", cwd: f.root, timestamp: "2026-10-10T00:00:00Z" }),
      JSON.stringify({ type: "session_info", id: "name-native", parentId: null, timestamp: "2026-10-10T00:00:00Z", name: session.name }),
    ].join("\n") + "\n");
    writeFileSync(f.mapPath, JSON.stringify({ version: 1, sessions: [
      { sessionId: "acp", cwd: f.root, piSessionPath: session.path, title: session.name, namedTitle: session.name },
    ] }));
    savedVectors(f, [{ id: "task", title: "Magic overhaul", vectorIndex: 0 }], [
      { acpId: "acp", title: "Research laboratory", vectorIndex: 0 },
    ]);
    f.consent(true, true);
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
    f.consent(true);
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
    second.consent(true);
    writeFileSync(second.auth, "{}");
    const noCredential = services(second);
    expect((await searchProject(second.root, { query: "conceptual redesign", sources: ["tasks"] }, noCredential)).hits).toEqual([]);
    expect(noCredential.calls).toEqual([]);
  });

  test("broken ACP session-map JSON never hides valid task vectors or exposes unverified session names", async () => {
    const f = fixture();
    taskDb(f.root, [{ id: "task", title: "Magic overhaul" }]);
    savedVectors(f, [{ id: "task", title: "Magic overhaul", vectorIndex: 0 }]);
    f.consent(true, true);
    writeFileSync(f.mapPath, "{not JSON");
    const session: SessionRecord = { id: "native", path: nativeSessionFile(f, "native", "Visible session"),
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
    f.consent(true);
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
    f.consent(true);
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
    const session: SessionRecord = { id: nativeId, path: nativeSessionFile(f, nativeId, firstName),
      cwd: f.root, name: firstName, firstMessage: "First question" };
    writeFileSync(f.mapPath, JSON.stringify({ version: 1, sessions: [{
      sessionId: "acp-original", cwd: f.root, piSessionPath: session.path, title: firstName, namedTitle: firstName,
    }] }));
    savedVectors(f, [], [{ acpId: "acp-original", title: firstName, vectorIndex: 0 }]);
    f.consent(false, true);
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

  test("revoking task consent during an in-flight embedding discards semantic results", async () => {
    const f = fixture();
    taskDb(f.root, [{ id: "task", title: "New magic" }]);
    savedVectors(f, [{ id: "task", title: "New magic", vectorIndex: 0 }]);
    f.consent(true);
    let entered!: () => void;
    let resume!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { resume = resolve; });
    const deps = services(f);
    deps.semantic!.embedQuery = async () => { entered(); await gate; return queryVector(0); };
    const pending = searchProject(f.root, { query: "conceptual redesign", sources: ["tasks"] }, deps);
    await started;
    f.consent(false);
    resume();
    expect((await pending).hits).toEqual([]);
  });

  test("symbol as well as lexical IDX modes do not enable cached task query embeddings", async () => {
    const f = fixture();
    taskDb(f.root, [{ id: "safe", title: "New magic" }]);
    savedVectors(f, [{ id: "safe", title: "New magic", vectorIndex: 0 }]);
    f.consent(true);
    const deps = services(f);
    for (const indexMode of ["lexical", "symbol"] as const) {
      const result = await searchProject(f.root, { query: "conceptual redesign", sources: ["tasks"], indexMode }, deps);
      expect(result.hits).toEqual([]);
    }
    expect(deps.calls).toEqual([]);
  });

  test("failed provider calls are sanitized and preserve ordinary lexical evidence", async () => {
    const f = fixture();
    taskDb(f.root, [{ id: "local", title: "Quest planning" }]);
    savedVectors(f, [{ id: "local", title: "Quest planning", vectorIndex: 0 }]);
    f.consent(true);
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
    f.consent(true);
    const redirect = fixture();
    const existing = path.join(f.root, ".pi/search");
        await renameWithRetry(existing, path.join(f.root, ".pi/original-search"));
    symlinkSync(path.join(redirect.root, ".pi/search"), existing);
    const deps = services(f);
    const result = await searchProject(f.root, { query: "conceptual redesign", sources: ["tasks"] }, deps);
    expect(result.hits).toEqual([]);
    expect(deps.calls).toEqual([]);
    expect(result.notices.join(" ")).toContain("local project results remain available");
  });

  test("actual embedding transport submits only a query and checks the pinned response model", async () => {
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
      const actual = await embedSemanticQuery("conceptual redesign", "fake-key", new AbortController().signal);
      expect(actual).toEqual(queryVector(0));
      expect(calls).toEqual([{
        url: "https://openrouter.ai/api/v1/embeddings",
        authorization: "Bearer fake-key",
        payload: { model: SEARCH_VECTOR_MODEL, input: ["conceptual redesign"], encoding_format: "float" },
      }]);
    } finally { globalThis.fetch = original; }
  });

  test("opted-in agent task search creates vectors once and reindexes only changed semantic text", async () => {
    const f = fixture();
    taskDb(f.root, [{ id: "work", title: "Shield tactics", description: "Initial armor" }]);
    f.consent(true);
    const deps = services(f);
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
    result = await searchProject(f.root, { query: "conceptual redesign", sources: ["tasks"] }, deps);
    expect(result.hits.map(hit => hit.taskId)).toEqual(["work"]);
    expect(deps.documents).toHaveLength(1);
    const changed = new Database(path.join(f.root, ".pi/tasks.sqlite"));
    try { changed.prepare("UPDATE tasks SET payload=json_set(payload,'$.description','Revised armor') WHERE id='work'").run(); }
    finally { changed.close(); }
    result = await searchProject(f.root, { query: "conceptual redesign", sources: ["tasks"] }, deps);
    expect(result.hits.map(hit => hit.taskId)).toEqual(["work"]);
    expect(deps.documents).toEqual([
      "Task title: Shield tactics\nTask description: Initial armor",
      "Task title: Shield tactics\nTask description: Revised armor",
    ]);
    const final = new Database(f.indexPath, { readonly: true });
    try {
      expect(final.query("SELECT COUNT(*) AS n FROM pix_task_vectors").get()?.n).toBe(1);
      expect(final.query("SELECT COUNT(*) AS n FROM pix_task_documents").get()?.n).toBe(1);
    } finally { final.close(); }
  });

  test("deleting the final task reconciles the semantic cache without new paid work", async () => {
    const f = fixture();
    taskDb(f.root, [{ id: "last", title: "Deleted objective" }]);
    f.consent(true);
    const deps = services(f);
    await searchProject(f.root, { query: "conceptual redesign", sources: ["tasks"] }, deps);
    const db = new Database(path.join(f.root, ".pi/tasks.sqlite"));
    try { db.prepare("DELETE FROM tasks WHERE id='last'").run(); }
    finally { db.close(); }
    const after = await searchProject(f.root, { query: "conceptual redesign", sources: ["tasks"] }, deps);
    expect(after.hits).toEqual([]);
    expect(deps.documents).toHaveLength(1);
    const index = new Database(f.indexPath, { readonly: true });
    try {
      expect(index.query("SELECT COUNT(*) AS n FROM pix_task_documents").get()?.n).toBe(0);
      expect(index.query("SELECT COUNT(*) AS n FROM pix_task_vectors").get()?.n).toBe(0);
    } finally { index.close(); }
  });

  test("unsafe task storage cannot authorize deleting a previously paid semantic cache", async () => {
    const f = fixture();
    taskDb(f.root, [{ id: "safe", title: "Canonical work" }]);
    f.consent(true);
    const deps = services(f);
    await searchProject(f.root, { query: "conceptual redesign", sources: ["tasks"] }, deps);
    const db = path.join(f.root, ".pi/tasks.sqlite");
    const alias = path.join(f.root, "database-hardlink-alias");
    const { linkSync, unlinkSync } = await import("node:fs");
    linkSync(db, alias);
    try {
      const result = await searchProject(f.root, { query: "conceptual redesign", sources: ["tasks"] }, deps);
      expect(result.hits).toEqual([]);
      expect(result.notices.join(" ")).toContain("invalid or unsafe SQLite");
      const index = new Database(f.indexPath, { readonly: true });
      try { expect(index.query("SELECT COUNT(*) AS n FROM pix_task_vectors").get()?.n).toBe(1); }
      finally { index.close(); }
    } finally { unlinkSync(alias); }
  });

  test("concurrent agent searches share the SQLite writer lock and never pay twice for one task hash", async () => {
    const f = fixture();
    taskDb(f.root, [{ id: "shared", title: "Realtime magic" }]);
    f.consent(true);
    const first = services(f), second = services(f);
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>(resolve => entered = resolve);
    const gate = new Promise<void>(resolve => release = resolve);
    first.semantic!.embedTasks = async texts => { first.documents.push(...texts); entered(); await gate; return texts.map(() => queryVector(0)); };
    const a = searchProject(f.root, { query: "conceptual redesign", sources: ["tasks"] }, first);
    await started;
    const b = searchProject(f.root, { query: "conceptual redesign", sources: ["tasks"] }, second);
    await new Promise(resolve => setTimeout(resolve, 50));
    release();
    const [aResult, bResult] = await Promise.all([a, b]);
    expect(aResult.hits.map(hit => hit.taskId)).toEqual(["shared"]);
    expect(bResult.hits.map(hit => hit.taskId)).toEqual(["shared"]);
    expect([...first.documents, ...second.documents]).toHaveLength(1);
    expect([...first.calls, ...second.calls]).toHaveLength(2);
  });

  test("revoked consent or a changed task during document embedding rolls back the pending vector", async () => {
    for (const outcome of ["revoke", "edit"] as const) {
      const f = fixture();
      taskDb(f.root, [{ id: "volatile", title: "Volatile idea" }]);
      f.consent(true);
      const deps = services(f);
      let entered!: () => void, release!: () => void;
      const started = new Promise<void>(resolve => entered = resolve);
      const gate = new Promise<void>(resolve => release = resolve);
      deps.semantic!.embedTasks = async texts => { deps.documents.push(...texts); entered(); await gate; return texts.map(() => queryVector(0)); };
      const pending = searchProject(f.root, { query: "conceptual redesign", sources: ["tasks"] }, deps);
      await started;
      if (outcome === "revoke") f.consent(false);
      else {
        const db = new Database(path.join(f.root, ".pi/tasks.sqlite"));
        try { db.prepare("UPDATE tasks SET payload=json_set(payload,'$.title','A completely changed idea') WHERE id='volatile'").run(); }
        finally { db.close(); }
      }
      release();
      const result = await pending;
      expect(result.hits).toEqual([]);
      const index = new Database(f.indexPath, { readonly: true });
      try {
        const exists = index.query("SELECT 1 AS present FROM sqlite_master WHERE type='table' AND name='pix_task_vectors'").get();
        if (exists) expect(index.query("SELECT COUNT(*) AS n FROM pix_task_vectors").get()?.n).toBe(0);
      }
      finally { index.close(); }
    }
  });

  test("saved session title search creates missing vectors, skips first-message fallbacks and respects renames", async () => {
    const f = fixture();
    const name = "Engineering council";
    const session: SessionRecord = { id: "native", path: nativeSessionFile(f, "native", name),
      cwd: f.root, name, firstMessage: "Draft project" };
    const fallback: SessionRecord = { id: "fallback", path: nativeSessionFile(f, "fallback", "First prompt"),
      cwd: f.root, name: "First prompt", firstMessage: "First prompt" };
    writeFileSync(f.mapPath, JSON.stringify({ version: 1, sessions: [
      { sessionId: "acp", cwd: f.root, piSessionPath: session.path, title: name, namedTitle: name },
      { sessionId: "acp-fallback", cwd: f.root, piSessionPath: fallback.path, title: "First prompt", namedTitle: "First prompt" },
    ] }));
    f.consent(false, true);
    const deps = services(f, { listSessions: async () => [session, fallback],
      readSession: async () => ({ firstText: "Background", finalText: "Agent result" }) });
    let result = await searchProject(f.root, { query: "conceptual redesign", sources: ["sessions"] }, deps);
    expect(result.hits.map(hit => hit.sessionId)).toEqual(["native"]);
    expect(deps.documents).toEqual([name]);
    const index = new Database(f.indexPath, { readonly: true });
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
    expect(result.hits.map(hit => hit.sessionId)).toEqual(["native"]);
    expect(deps.documents).toEqual([name, revisedName]);
    const again = new Database(f.indexPath, { readonly: true });
    try {
      expect(again.query("SELECT COUNT(*) AS n FROM pix_session_vectors").get()?.n).toBe(1);
      expect(again.query("SELECT title FROM pix_session_titles WHERE session_id='acp'").get()?.title).toBe(revisedName);
    } finally { again.close(); }
  });

  test("a 260-task backlog indexes at most 256 new texts per agent search and resumes later", { timeout: 20_000 }, async () => {
    const f = fixture();
    taskDb(f.root, Array.from({ length: 260 }, (_, index) => ({ id: `task-${index}`, title: `Task subject ${index}` })));
    f.consent(true);
    const deps = services(f);
    const first = await searchProject(f.root, { query: "conceptual redesign", sources: ["tasks"], limit: 10 }, deps);
    expect(first.hits).toHaveLength(10);
    expect(deps.documents).toHaveLength(256);
    expect(first.notices.join(" ")).toContain("4 task texts still await indexing");
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
    f.consent(true);
    writeFileSync(f.auth, "{}");
    const deps = services(f);
    const result = await searchProject(f.root, { query: "abstract topic", sources: ["tasks"] }, deps);
    expect(result.hits).toEqual([]);
    expect(deps.documents).toEqual([]);
    expect(deps.calls).toEqual([]);
    expect(existsSync(f.indexPath)).toBe(false);
  });

  test("commit search creates missing vectors with the existing IDX provider identity and reuses them", async () => {
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
    const db = new Database(f.indexPath, { readonly: true });
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
        const db = new Database(f.indexPath, { readonly: true });
        try {
          const exists = db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='pix_commit_vectors'").get();
          if (exists) expect(db.query("SELECT COUNT(*) AS n FROM pix_commit_vectors").get()?.n).toBe(0);
        } finally { db.close(); }
      }
    }
  });

  test("changing the IDX embedding model while a commit query is in flight discards stale ranking", async () => {
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
