import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile, appendFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { prepareFederatedRerank, rerankFederated } from "../src/project-search/federation-reranker.mjs";
import { selectFederatedCandidates, applyFederatedOrder } from "../src/project-search/federation-ranking.mjs";
import { searchNative } from "../src/project-search/native-engine.mjs";
import { nativeSessionDirectory } from "../src/project-search/session-discovery.mjs";
import { writeSourcePolicy } from "../src/project-search/source-policy.mjs";
import { searchProject } from "../src/project-search/engine.js";
import type { FederatedRerankRequest, FederatedSource } from "../src/project-search/native-contract.js";
import { enableSearchSources } from "./support/search-sources.js";

const saved = { HOME: process.env.HOME, PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
  OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY, PIX_ACP_SESSION_MAP: process.env.PIX_ACP_SESSION_MAP };
const all: FederatedSource[] = ["sessions", "tasks", "commits", "code", "knowledge"];
let directory: string, root: string, config: string, session: string;
const signal = () => new AbortController().signal;
const git = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "pipe" });
const configure = (model = "voyageai/rerank-3-lite") => writeFile(config, JSON.stringify({ search: { rerankerModel: model } }));
function tasks(title = "needle task") {
  const db = new Database(join(root, ".pi/tasks.sqlite"), { create: true });
  try {
    db.exec("PRAGMA journal_mode=WAL");
    db.exec("CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY,payload TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 1,position INTEGER NOT NULL DEFAULT 0); CREATE TABLE IF NOT EXISTS attachments(hash TEXT PRIMARY KEY,name TEXT NOT NULL,size INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS task_attachments(task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,hash TEXT NOT NULL REFERENCES attachments(hash),ordinal INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(task_id,hash)); PRAGMA user_version=1;");
    db.prepare("INSERT OR REPLACE INTO tasks(id,payload,revision) VALUES(?,?,?)").run("t", JSON.stringify({ id: "t", title, description: "needle recovery", type: "feature", status: "todo", priority: "medium", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" }), title.length);
  } finally { db.close(); }
}
beforeEach(async () => {
  const storage = resolve(import.meta.dir, "../../../.pi/artifacts");
  await mkdir(storage, { recursive: true }); directory = await mkdtemp(join(storage, "federation-fixture-"));
  root = join(directory, "project"); await mkdir(root); enableSearchSources(root);
  process.env.HOME = join(directory, "home"); process.env.PI_CODING_AGENT_DIR = join(process.env.HOME, ".pi/agent");
  process.env.PIX_ACP_SESSION_MAP = join(directory, "missing-map.json"); delete process.env.OPENROUTER_API_KEY;
  config = join(process.env.HOME, ".config/pi/pi-tools-suite.jsonc"); await mkdir(join(process.env.HOME, ".config/pi"), { recursive: true }); await configure();
  const sessions = nativeSessionDirectory(root, process.env.PI_CODING_AGENT_DIR); await mkdir(sessions, { recursive: true });
  session = join(sessions, "session.jsonl");
  await writeFile(session, [{ type: "session", version: 3, id: "s", cwd: root, timestamp: "2026-01-01T00:00:00Z" },
    { type: "message", id: "u", parentId: null, message: { role: "user", content: "needle session" } }].map(row => JSON.stringify(row)).join("\n") + "\n");
  tasks();
  await writeFile(join(root, "owner.ts"), "export const needle = 42;\n"); await writeFile(join(root, "guide.md"), "# needle guide\nRecovery decisions\n");
  git("init", "-q"); git("config", "user.email", "fixture@example.test"); git("config", "user.name", "Fixture");
  git("add", "owner.ts", "guide.md"); git("commit", "-qm", "needle commit");
});
afterEach(async () => {
  for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  if (directory) await rm(directory, { recursive: true, force: true });
});
async function request(sources = all): Promise<FederatedRerankRequest> {
  const { context } = await prepareFederatedRerank(root, sources, signal());
  const native = sources.filter((source): source is "code" | "knowledge" => source === "code" || source === "knowledge");
  const response = native.length ? await searchNative(root, { query: "needle", mode: "lexical", sources: native, limit: 100, includeContent: true, skipRerank: true }) : { hits: [], rerankContext: undefined };
  return { query: "needle", context: context!, nativeContext: response.rerankContext,
    candidates: [...sources.filter(source => !native.includes(source as any)).map(kind => ({ kind, id: kind, title: `${kind} needle`, snippet: "needle snippet", content: "PRIVATE_FULL_HISTORY" })), ...response.hits] };
}
function provider() {
  const calls: { query: string; documents: string[] }[] = [];
  return { calls, rerankerKey: async () => "fixture-key", rerank: async (query: string, documents: string[]) => {
    calls.push({ query, documents }); return documents.map((_, index) => ({ index, relevance_score: (index + 1) / documents.length })).reverse();
  } };
}

describe("federated repository reranking", () => {
  test("one call ranks all five sources; history uploads only bounded title/snippets", async () => {
    const input = await request(), p = provider();
    input.candidates[0]!.title = "t".repeat(1000); input.candidates[0]!.snippet = "s".repeat(20000);
    const result = await rerankFederated(root, input, p);
    expect(result.notices).toEqual([]); expect(result.order).toHaveLength(input.candidates.length);
    expect(p.calls).toHaveLength(1); expect(p.calls[0]!.documents).toHaveLength(input.candidates.length);
    expect(p.calls[0]!.documents.join("\n")).not.toContain("PRIVATE_FULL_HISTORY");
    expect(p.calls[0]!.documents.every(text => text.length <= 8192)).toBe(true);
    expect(new Set(result.order!.map(hit => hit.kind))).toEqual(new Set(all));
  });
  for (const source of ["sessions", "tasks", "commits"] as const) {
    test(`${source} changed during transport drops ranking`, async () => {
      const input = await request([source]), p = provider();
      const result = await rerankFederated(root, input, { ...p, rerank: async (...args: Parameters<typeof p.rerank>) => {
        const response = await p.rerank(...args);
        if (source === "tasks") tasks("changed task");
        if (source === "sessions") await appendFile(session, JSON.stringify({ type: "message", id: "new", parentId: "u", message: { role: "assistant", content: "new response" } }) + "\n");
        if (source === "commits") git("commit", "--allow-empty", "-qm", "new HEAD");
        return response;
      } });
      expect(p.calls).toHaveLength(1); expect(result.order).toBeUndefined(); expect(result.notices.join()).toContain("original ranking retained");
    });
  }
  test("changed history before HTTP prevents upload", async () => {
    const input = await request(["tasks"]), p = provider(); tasks("changed task");
    expect((await rerankFederated(root, input, p)).order).toBeUndefined(); expect(p.calls).toHaveLength(0);
  });
  test("native bytes and generations are fenced before and after HTTP", async () => {
    const input = await request(["code"]), p = provider();
    const response = await rerankFederated(root, input, { ...p, rerank: async (...args: Parameters<typeof p.rerank>) => {
      const ranked = await p.rerank(...args); await writeFile(join(root, "owner.ts"), "export const needle = 99;\n"); return ranked;
    } });
    expect(response.order).toBeUndefined();
    await searchNative(root, { query: "needle", sources: ["code"], mode: "lexical" });
    const next = provider(); expect((await rerankFederated(root, input, next)).order).toBeUndefined(); expect(next.calls).toHaveLength(0);
  });
  test("policy revocation prevents upload; configuration revocation cancels transport", async () => {
    const input = await request(["tasks"]), p = provider(); await writeSourcePolicy(root, "tasks", false);
    expect((await rerankFederated(root, input, p)).order).toBeUndefined(); expect(p.calls).toHaveLength(0);
    await writeSourcePolicy(root, "tasks", true); const next = await request(["tasks"]); let aborted = false;
    const result = await rerankFederated(root, next, { rerankerKey: async () => "key", rerank: async (_q, _d, _m, _k, owned) => {
      await configure(""); await new Promise<void>(resolve => owned.addEventListener("abort", () => { aborted = true; resolve(); }, { once: true })); return [];
    } });
    expect(aborted).toBe(true); expect(result.order).toBeUndefined();
  });
  test("abort rejects without publishing fallback; malformed and missing-key responses redact errors", async () => {
    const input = await request(["tasks"]), caller = new AbortController();
    await expect(rerankFederated(root, input, { signal: caller.signal, rerankerKey: async () => "key", rerank: async () => { caller.abort(); return []; } })).rejects.toThrow();
    for (const deps of [{ rerankerKey: async () => undefined }, { rerankerKey: async () => "key", rerank: async () => [] },
      { rerankerKey: async () => "key", rerank: async () => { throw new Error("SECRET_PROVIDER_BODY"); } }]) {
      const result = await rerankFederated(root, input, deps); expect(result.order).toBeUndefined(); expect(JSON.stringify(result)).not.toContain("SECRET_PROVIDER_BODY");
    }
  });
  test("disabled reranker does not prepare or call a provider", async () => {
    const input = await request(["tasks"]), p = provider(); await configure("");
    expect(await prepareFederatedRerank(root, ["tasks"])).toEqual({}); expect(await rerankFederated(root, input, p)).toEqual({ notices: [] }); expect(p.calls).toHaveLength(0);
  });
  test("candidate budgets keep source diversity; invalid orders cannot erase local metadata", () => {
    const hits = Array.from({ length: 120 }, (_, i) => ({ kind: "code", id: String(i), score: i }));
    const task = { kind: "tasks", id: "t", score: 0 }, setting = { kind: "settings", id: "x", score: 0 };
    const candidates = selectFederatedCandidates([...hits, task, setting]); expect(candidates).toHaveLength(100); expect(candidates).toContain(task); expect(candidates).not.toContain(setting);
    expect(applyFederatedOrder(candidates, [])).toBeUndefined();
    expect(applyFederatedOrder([task], [{ kind: "tasks", id: "t", score: NaN }])).toBeUndefined();
    expect(applyFederatedOrder([task], [{ kind: "tasks", id: "t", score: 0.9 }])).toEqual([{ ...task, score: 0.9 }]);
  });
  test("tool reranks once across five sources before final limit; lexical never reranks", async () => {
    const p = provider(), deps = { listSessions: async () => [{ id: "s", path: session, cwd: root, firstMessage: "needle session" }], reranker: p };
    const result = await searchProject(root, { query: "needle", sources: all, limit: 1, maxFiles: 50 }, deps);
    expect(p.calls).toHaveLength(1); expect(p.calls[0]!.documents.some(text => text.startsWith("commits\n"))).toBe(true);
    expect(p.calls[0]!.documents.some(text => text.startsWith("sessions\n"))).toBe(true);
    expect(p.calls[0]!.documents.some(text => text.startsWith("tasks\n"))).toBe(true);
    expect(result.hits).toHaveLength(1); expect(result.hits[0]!.score).toBe(1);
    const native: any[] = [];
    await searchProject(root, { query: "needle", sources: all, indexMode: "lexical" }, { ...deps, native: async (_root, query) => {
      native.push(query); return searchNative(_root, query);
    } });
    expect(p.calls).toHaveLength(1); expect(native[0].skipRerank).toBe(true);
  });
});
