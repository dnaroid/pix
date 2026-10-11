import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runSourceIndex, type IndexServices } from "../src/project-search/index-runner.js";
import { readIndexStatus } from "../src/project-search/index-status.js";
import { readCachedProjectVectors } from "../src/project-search/semantic-cache.js";
import { indexMissingSessionVectors } from "../src/project-search/semantic-session-indexer.js";
import type { CommitEmbeddingConfig } from "../src/project-search/semantic-commit-provider.js";

const roots: string[] = [];
const home = process.env.HOME;
afterEach(() => { process.env.HOME = home; for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const config: CommitEmbeddingConfig = { provider: "ollama", model: "fixture", dimension: 2,
  documentPrefix: "document: ", queryPrefix: "query: ", baseUrl: "http://127.0.0.1:1" };
const vector = [1, 0];
function fixture() {
  const dir = fileURLToPath(new URL("../../../.pi/artifacts/", import.meta.url));
  mkdirSync(dir, { recursive: true });
  const root = mkdtempSync(join(dir, "tui-index-fixture-")); roots.push(root);
  process.env.HOME = root;
  mkdirSync(join(root, ".pi"));
  const batches: string[][] = [];
  const services: IndexServices = { semantic: { loadConfig: async () => config,
    sessionMapPath: join(root, "absent-map.json"), embedQuery: async () => { throw new Error("No query allowed"); },
    embedTasks: async texts => { batches.push([...texts]); return texts.map(() => vector); } },
    commits: { embed: async texts => { batches.push([...texts]); return texts.map(() => vector); } } };
  return { root, batches, services };
}
function sessions(root: string, count: number) {
  return Array.from({ length: count }, (_, n) => {
    const id = `native-${n}`, name = `Explicit saved name ${n}`, path = join(root, `${id}.jsonl`);
    writeFileSync(path, [JSON.stringify({ type: "session", version: 3, id, cwd: root, timestamp: "2026-10-11T00:00:00Z" }),
      JSON.stringify({ type: "session_info", id: `info-${n}`, parentId: null, timestamp: "2026-10-11T00:00:00Z", name })].join("\n") + "\n");
    return { id, path, name, cwd: root, firstMessage: "Initial prompt", allMessagesText: "", created: new Date(), modified: new Date(), messageCount: 0 };
  });
}
function taskCorpus(root: string, count: number) {
  const path = join(root, ".pi/tasks.sqlite");
  const db = new Database(path, { create: true });
  db.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE tasks(id TEXT PRIMARY KEY,payload TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 1,position INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE attachments(hash TEXT PRIMARY KEY,name TEXT NOT NULL,size INTEGER NOT NULL);
    CREATE TABLE task_attachments(task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,hash TEXT NOT NULL REFERENCES attachments(hash),ordinal INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(task_id,hash));
    PRAGMA user_version=1;`);
  for (let n = 0; n < count; n++) db.prepare("INSERT INTO tasks(id,payload,position) VALUES(?,?,?)").run(`${n}`, JSON.stringify({ id: `${n}`,
    title: `Task ${n}`, type: "feature", status: "todo", priority: "medium", createdAt: "2026-10-11T00:00:00Z", updatedAt: "2026-10-11T00:00:00Z" }), n);
  db.close();
  return path;
}
const signal = () => new AbortController().signal;
function count(root: string, source: string, table: string) {
  const db = new Database(join(root, `.pi/search/${source}.sqlite`), { readonly: true });
  try { return db.query(`SELECT count(*) AS n FROM ${table}`).get()?.n; } finally { db.close(); }
}
function canonicalRows(path: string) {
  const db = new Database(path, { readonly: true });
  try { return db.query("SELECT * FROM tasks ORDER BY id").all(); } finally { db.close(); }
}

test("manual sessions drain beyond 256 using native saved names without ACP mapping, and search reuses them", async () => {
  const f = fixture(), candidates = sessions(f.root, 270);
  f.services.sessions = async () => candidates;
  expect(await runSourceIndex(f.root, "sessions", signal(), f.services)).toMatchObject({ complete: true, indexed: 270 });
  expect(f.batches.flat()).toHaveLength(270);
  expect(f.batches.every(batch => batch.length <= 16)).toBe(true);
  expect(count(f.root, "sessions", "pix_session_vectors")).toBe(270);
  const cached = await readCachedProjectVectors(f.root, { tasks: [], sessions: candidates }, f.services.semantic!, signal(), config);
  expect(cached.sessions.size).toBe(270);
  expect(await runSourceIndex(f.root, "sessions", signal(), f.services)).toMatchObject({ complete: true, indexed: 0 });
  expect(f.batches.flat()).toHaveLength(270);
}, 30_000);

test("ordinary session search retains its 256-vector budget", async () => {
  const f = fixture(), candidates = sessions(f.root, 260);
  const result = await indexMissingSessionVectors(f.root, candidates, undefined, f.services.semantic!, signal(), config);
  expect(result).toEqual({ indexed: 256, remaining: 4 });
}, 30_000);

test("native saved names reject first-message fallbacks, wrong headers and stale Desktop mappings", async () => {
  const f = fixture(), candidates = sessions(f.root, 4);
  candidates[0]!.firstMessage = candidates[0]!.name;
  writeFileSync(candidates[1]!.path, JSON.stringify({ type: "session", version: 3, id: candidates[1]!.id, cwd: "/elsewhere" }) + "\n"
    + JSON.stringify({ type: "session_info", id: "info", parentId: null, name: candidates[1]!.name }) + "\n");
  writeFileSync(candidates[2]!.path, JSON.stringify({ type: "session", version: 3, id: "wrong", cwd: f.root }) + "\n"
    + JSON.stringify({ type: "session_info", id: "info", parentId: null, name: candidates[2]!.name }) + "\n");
  writeFileSync(f.services.semantic!.sessionMapPath!, JSON.stringify({ version: 1, sessions: [{ cwd: f.root,
    sessionId: "desktop", piSessionPath: candidates[3]!.path, namedTitle: "Stale name", title: "Stale name" }] }));
  f.services.sessions = async () => candidates;
  expect(await runSourceIndex(f.root, "sessions", signal(), f.services)).toMatchObject({ complete: true, indexed: 0 });
  expect(f.batches).toHaveLength(0);
});

test("tasks drain without query upload or canonical task mutation; retries retain paid batches", async () => {
  const f = fixture(), path = taskCorpus(f.root, 270), original = canonicalRows(path);
  let calls = 0;
  f.services.semantic!.embedTasks = async texts => {
    if (++calls === 2) throw new Error("fixture provider failure");
    f.batches.push([...texts]); return texts.map(() => vector);
  };
  await expect(runSourceIndex(f.root, "tasks", signal(), f.services)).rejects.toThrow();
  expect(count(f.root, "tasks", "pix_task_vectors")).toBe(16);
  f.services.semantic!.embedTasks = async texts => { f.batches.push([...texts]); return texts.map(() => vector); };
  expect(await runSourceIndex(f.root, "tasks", signal(), f.services)).toMatchObject({ complete: true, indexed: 254 });
  expect(f.batches.flat()).toHaveLength(270);
  expect(canonicalRows(path)).toEqual(original);
});

test("manual commit pagination is HEAD-pinned, drains past 256 and never embeds a query", async () => {
  const f = fixture(), head = "a".repeat(40);
  const calls: string[][] = [];
  f.services.git = async (_root, args) => {
    calls.push(args);
    if (args[0] === "rev-parse") return head;
    expect(args[1]).toBe(head);
    const skip = Number(args.find(arg => arg.startsWith("--skip="))!.split("=")[1]);
    return Array.from({ length: skip === 0 ? 256 : 14 }, (_, i) => {
      const hash = (skip + i).toString(16).padStart(40, "0");
      return [`PIX-PROJECT-COMMIT:${hash}`, hash.slice(0, 7), `Commit ${skip + i}`, "Author", "2026-10-11", `Body ${i}`, "\nfile.ts", ""].join("\0");
    }).join("");
  };
  expect(await runSourceIndex(f.root, "commits", signal(), f.services)).toEqual({ complete: true, indexed: 270 });
  expect(f.batches.flat()).toHaveLength(270);
  expect(f.batches.every(batch => batch.length <= 16 && batch.every(text => text.startsWith("document: ")))).toBe(true);
  expect(count(f.root, "git-commits", "pix_commit_vectors")).toBe(270);
  expect(calls.filter(args => args[0] === "log")).toHaveLength(2);
});

test("cancellation retains source ownership until uncooperative transport settles and forbids late publish", async () => {
  const f = fixture(); taskCorpus(f.root, 1);
  const abort = new AbortController();
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => entered = resolve), held = new Promise<void>(resolve => release = resolve);
  f.services.semantic!.embedTasks = async texts => { entered(); await held; return texts.map(() => vector); };
  let settled = false;
  const running = runSourceIndex(f.root, "tasks", abort.signal, f.services).catch(() => {}).finally(() => settled = true);
  await started; abort.abort();
  await new Promise(resolve => setTimeout(resolve, 10)); expect(settled).toBe(false);
  release(); await running;
  expect(count(f.root, "tasks", "pix_task_vectors")).toBe(0);
});

test("configuration switch during a batch cannot publish incompatible vectors", async () => {
  const f = fixture(); taskCorpus(f.root, 1);
  f.services.semantic!.embedTasks = async texts => {
    f.services.semantic!.loadConfig = async () => ({ ...config, model: "replacement" });
    return texts.map(() => vector);
  };
  await expect(runSourceIndex(f.root, "tasks", signal(), f.services)).rejects.toThrow("configuration changed");
  expect(count(f.root, "tasks", "pix_task_vectors")).toBe(0);
});

test("status never creates storage; rejects redirected caches and shows stored—not coverage—counts", async () => {
  const f = fixture();
  expect(await readIndexStatus(f.root)).toHaveLength(5);
  expect(existsSync(join(f.root, ".pi/search"))).toBe(false);
  taskCorpus(f.root, 1); await runSourceIndex(f.root, "tasks", signal(), f.services);
  const before = f.batches.length;
  expect((await readIndexStatus(f.root)).join(" ")).toContain("tasks: 1 stored items, 1 stored vectors");
  expect(f.batches).toHaveLength(before);
  symlinkSync(join(f.root, ".pi/search/tasks.sqlite"), join(f.root, ".pi/search/code.sqlite"));
  expect((await readIndexStatus(f.root))[0]).toBe("code: stored index unavailable");
});

test("unconfigured histories do not initialize caches; native commands pass only document requests", async () => {
  const f = fixture();
  f.services.semantic!.loadConfig = async () => undefined;
  expect(await runSourceIndex(f.root, "sessions", signal(), f.services)).toMatchObject({ complete: false });
  expect(existsSync(join(f.root, ".pi/search"))).toBe(false);
  f.services.native = async (root, source, owned) => {
    expect(root).toBe(f.root); expect(owned.aborted).toBe(false);
    return { source, complete: true, indexed: 300, total: 300 };
  };
  for (const source of ["code", "knowledge"] as const) expect(await runSourceIndex(f.root, source, signal(), f.services)).toMatchObject({ source, complete: true });
});
