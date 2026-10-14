import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Database } from "bun:sqlite";
import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";
import { removeDirsWithRetry } from "./support/fs-retry.js";
import { enableSearchSources } from "./support/search-sources.js";
import projectSearchExtension from "../src/project-search/index.js";
import {
  formatProjectSearch, parseGitHistory, parseProjectSearchParams, readSessionBoundary,
  searchProject, type ProjectSearchServices, type SessionRecord,
} from "../src/project-search/engine.js";

const directories: string[] = [];
const originalEnvironment = { HOME: process.env.HOME, PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR, OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY };
beforeEach(() => {
  process.env.HOME = fixture();
  process.env.PI_CODING_AGENT_DIR = path.join(process.env.HOME, ".pi", "agent");
  delete process.env.OPENROUTER_API_KEY;
});
afterEach(async () => {
  for (const [key, value] of Object.entries(originalEnvironment)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await removeDirsWithRetry(directories);
});
const fixture = () => {
  const root = mkdtempSync(path.join(tmpdir(), "pix-project-search-"));
  directories.push(root);
  enableSearchSources(root);
  return root;
};
const signal = () => new AbortController().signal;
const services: ProjectSearchServices = {
  listSessions: async () => [],
};
function writeSearchTasks(root: string, records: Array<Record<string, unknown>>): void {
  const folder = path.join(root, ".pi");
  mkdirSync(folder, { recursive: true });
  const db = new Database(path.join(folder, "tasks.sqlite"), { create: true });
  try {
    db.exec("PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY,payload TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 1,position INTEGER NOT NULL DEFAULT 0); CREATE TABLE IF NOT EXISTS attachments(hash TEXT PRIMARY KEY,name TEXT NOT NULL,size INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS task_attachments(task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE, hash TEXT NOT NULL REFERENCES attachments(hash), ordinal INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(task_id,hash)); PRAGMA user_version=1");
    const insert = db.prepare("INSERT INTO tasks(id,payload,position) VALUES(?,?,?)");
    for (const [index, record] of records.entries()) {
      const task = { createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", ...record };
      insert.run(task.id, JSON.stringify(task), index);
    }
  } finally { db.close(); }
}

describe("project_search shared store lookup", () => {
  test("sandbox attachments do not leak through boundaries or first-message fallbacks", async () => {
    const root = fixture(), filename = path.join(root, "sandbox.jsonl");
    const text = "Request\n```pix-html\nsecretneedle\n```\nordinaryprose";
    writeFileSync(filename, [
      { type: "session", version: 3, id: "sandbox", cwd: root, timestamp: "2026-01-01T00:00:00Z" },
      { type: "message", id: "u", parentId: null, message: { role: "user", content: text } },
      { type: "message", id: "a", parentId: "u", message: { role: "assistant", stopReason: "stop", content: text } },
    ].map(row => JSON.stringify(row)).join("\n") + "\n");
    expect(await readSessionBoundary(filename, signal())).toEqual({ firstText: "Request\nordinaryprose", finalText: "Request\nordinaryprose" });
    const deps: ProjectSearchServices = { listSessions: async () => [{ id: "sandbox", path: filename, cwd: root, firstMessage: text }],
      readSession: async () => undefined };
    const hidden = await searchProject(root, { query: "secretneedle", sources: ["sessions"], indexMode: "lexical" }, deps);
    expect(hidden.hits).toHaveLength(0);
    const visible = await searchProject(root, { query: "ordinaryprose", sources: ["sessions"], indexMode: "lexical" }, deps);
    expect(visible.hits).toHaveLength(1);
    expect(JSON.stringify(visible.hits)).not.toContain("secretneedle");
  });
  test("native JSONL lookup follows the active branch and ignores tool-use outputs and abandoned answers", async () => {
    const root = fixture();
    const filename = path.join(root, "example.jsonl");
    const entry = (id: string, parentId: string | null, role: string, text: string, stopReason?: string) =>
      JSON.stringify({ type: "message", id, parentId, timestamp: "2026-01-01T00:00:00Z",
        message: { role, content: [{ type: "text", text }], ...(stopReason ? { stopReason } : {}) } });
    writeFileSync(filename, [
      JSON.stringify({ type: "session", version: 3, id: "example", cwd: root, timestamp: "2026-01-01T00:00:00Z" }),
      entry("u1", null, "user", "initial lookup request"),
      entry("a1", "u1", "assistant", "a tool request is not a final reply", "toolUse"),
      entry("a2", "a1", "assistant", "old discarded reply", "stop"),
      entry("u2", "u1", "user", "revisited task"),
      entry("a3", "u2", "assistant", "final project decision", "stop"),
    ].join("\n") + "\n");
    expect(await readSessionBoundary(filename, signal())).toEqual({
      firstText: "initial lookup request",
      finalText: "final project decision",
    });
    expect(await readSessionBoundary(filename, signal())).toEqual({
      firstText: "initial lookup request", finalText: "final project decision",
    });
    const cancelled = new AbortController(); cancelled.abort();
    await expect(readSessionBoundary(filename, cancelled.signal)).rejects.toBeDefined();
    const { appendFileSync } = await import("node:fs");
    appendFileSync(filename, entry("a4", "u2", "assistant", "new active-branch decision", "stop") + "\n");
    expect((await readSessionBoundary(filename, signal()))?.finalText).toBe("new active-branch decision");
    const { symlinkSync } = await import("node:fs");
    symlinkSync(filename, path.join(root, "alias.jsonl"));
    expect(await readSessionBoundary(path.join(root, "alias.jsonl"), signal())).toBeUndefined();
  });
  test("strict argument validation bounds searches before touching any project data", () => {
    expect(parseProjectSearchParams({ query: "decision" }).params).toMatchObject({
      query: "decision", sources: ["sessions", "tasks", "commits", "code", "knowledge"],
      limit: 10, indexMode: "hybrid",
    });
    for (const invalid of [
      {}, [], { query: "" }, { query: "x".repeat(2049) }, { query: "\0" },
      { query: "-Gneedle" }, { query: "decision", limit: 0 },
      { query: "decision", limit: 21 }, { query: "decision", limit: 1.5 },
      { query: "decision", sources: [] }, { query: "decision", sources: ["tasks", "tasks"] },
      { query: "decision", sources: ["settings"] }, { query: "decision", indexMode: "other" },
      { query: "decision", projectPath: "../../\0" }, { query: "decision", unexpected: true },
      { query: "x", pathPrefix: "../outside" }, { query: "x", pathPrefix: "/absolute" },
      { query: "x", pathPrefix: "src\\bad" }, { query: "x", pathPrefix: "--unsafe" },
      { query: "x", pathPrefix: "src/./child" }, { query: "x", pathPrefix: "src//child" },
      { query: "x", maxFiles: -1 }, { query: "x", maxFiles: 51 },
      { query: "x", minScore: -0.1 }, { query: "x", minScore: 1.1 },
      { query: "x", minScore: NaN }, { query: "x", minScore: "0.5" },
      { query: "x", chunkTypes: ["impl", "impl"] }, { query: "x", chunkTypes: ["unknown"] },
      { query: "x", chunkTypes: [] }, { query: "x", includeContent: "true" },
      { query: "x", dedupeFile: "true" }, { query: "x", includeTests: true, excludeTests: true },
    ]) expect(parseProjectSearchParams(invalid).error).toContain("Invalid project_search request");
    for (const indexMode of ["hybrid", "semantic", "lexical"]) {
      expect(parseProjectSearchParams({ query: "test", indexMode }).params?.indexMode).toBe(indexMode);
    }
    expect(parseProjectSearchParams({ query: "test", maxFiles: 50 }).params?.maxFiles).toBe(50);
  });

  test("searches saved project tasks and session first/final excerpts, never tool bodies", async () => {
    const root = fixture();
    mkdirSync(path.join(root, ".pi"), { recursive: true });
    writeSearchTasks(root, [
      { id: "TASK-42", title: "Resolve semaphore race", description: "Cancel pending requests",
        status: "done", type: "bug", priority: "high" },
      { id: "TASK-43", title: "Unrelated documentation", description: "Write a README",
        status: "todo", type: "feature", priority: "low" },
    ]);
    const sessions: SessionRecord[] = [
      { id: "session-1", cwd: root, path: "/sessions/native-1.jsonl", name: "Architecture review", firstMessage: "question" },
      { id: "session-other", cwd: "/other/project", path: "/sessions/other.jsonl", firstMessage: "race" },
    ];
    let calls = 0;
    const result = await searchProject(root, { query: "semaphore race", sources: ["sessions", "tasks"] }, {
      ...services,
      listSessions: async () => sessions,
      readSession: async pathname => {
        calls++;
        expect(pathname).toBe(sessions[0]!.path);
        return { firstText: "We discussed semaphore races", finalText: "Final answer: semaphore race is resolved" };
      },
    }, signal());
    expect(result.hits.map(hit => hit.id).sort()).toEqual(["sessions:session-1", "tasks:TASK-42"]);
    expect(calls).toBe(1);
    expect(result.hits.find(hit => hit.kind === "sessions")).toMatchObject({
      sessionId: "session-1", sessionPath: "/sessions/native-1.jsonl",
    });
    expect(result.hits.find(hit => hit.kind === "tasks")).toMatchObject({
      taskId: "TASK-42", title: "Resolve semaphore race",
    });
    expect(JSON.stringify(result)).not.toContain("TASK-43");
    expect(formatProjectSearch(result)).toContain("Source ID:");
  });

  test("reads task hierarchy as a whole and searches linked artifacts, related titles, session and model", async () => {
    const root = fixture();
    writeSearchTasks(root, [
      { id: "EPIC-1", title: "Magic overhaul", status: "todo", type: "feature", priority: "high", epic: true },
      { id: "CHILD-2", title: "Elemental spells", description: "Balance combat spells", status: "todo", type: "idea", priority: "medium",
        parentId: "EPIC-1", relatedTaskIds: ["EPIC-1"], links: ["docs/elemental-design.md"], sessionId: "session-local-42", modelRef: "provider/smart-model:high" },
    ]);
    const db = new Database(path.join(root, ".pi", "tasks.sqlite"));
    try {
      db.exec("PRAGMA foreign_keys=ON");
      db.prepare("INSERT INTO attachments(hash,name,size) VALUES(?,?,?)").run("a".repeat(64), "analysis-metadata.png", 10);
      db.prepare("INSERT INTO task_attachments(task_id,hash,ordinal) VALUES(?,?,?)").run("CHILD-2", "a".repeat(64), 0);
    } finally { db.close(); }
    for (const [query, expected] of [
      ["overhaul", ["EPIC-1", "CHILD-2"]],
      ["elemental-design.md", ["EPIC-1", "CHILD-2"]],
      ["analysis-metadata.png", ["CHILD-2"]],
      ["session-local-42", ["CHILD-2"]],
      ["smart-model", ["CHILD-2"]],
      ["эпик", ["EPIC-1"]],
    ] as const) {
      const result = await searchProject(root, { query, sources: ["tasks"] }, services);
      expect(result.notices).toEqual([]);
      expect(result.hits.map(hit => hit.taskId).sort()).toEqual([...expected].sort());
    }
  });

  test("an explicitly selected alternate project changes scope but never the session cwd", async () => {
    const sessionRoot = fixture();
    const other = fixture();
    mkdirSync(path.join(sessionRoot, ".pi"), { recursive: true });
    mkdirSync(path.join(other, ".pi"), { recursive: true });
    writeSearchTasks(sessionRoot, [{ id: "OLD", title: "Existing client", type: "feature", status: "done", priority: "low" }]);
    writeSearchTasks(other, [{ id: "NEW", title: "Alternate project target", type: "bug", status: "todo", priority: "high" }]);
    const response = await searchProject(sessionRoot, {
      query: "alternate project", sources: ["tasks"],
      projectPath: path.relative(sessionRoot, other),
    }, services);
    expect(response.projectRoot).toBe(await realpath(other));
    expect(response.hits.map(hit => hit.id)).toEqual(["tasks:NEW"]);
    const same = await searchProject(sessionRoot, { query: "existing client", sources: ["tasks"] }, services);
    expect(same.projectRoot).toBe(await realpath(sessionRoot));
    expect(same.hits.map(hit => hit.id)).toEqual(["tasks:OLD"]);
  });

  test("rejects redirected task storage and continues searching other sources without reading it", async () => {
    const root = fixture(), external = fixture();
    mkdirSync(path.join(external, ".pi"), { recursive: true });
    writeSearchTasks(external, [{ id: "secret", title: "Secret Access", status: "todo", type: "feature", priority: "medium" }]);
    const { symlinkSync } = await import("node:fs");
    await rm(path.join(root, ".pi"), { recursive: true, force: true });
    symlinkSync(path.join(external, ".pi"), path.join(root, ".pi"));
    const response = await searchProject(root, { query: "secret", sources: ["tasks", "sessions"] },
      { ...services, listSessions: async () => [] });
    expect(response.hits).toEqual([]);
  });

  test("native repository search coexists with local history without external setup", async () => {
    const root = fixture();
    mkdirSync(path.join(root, ".pi"), { recursive: true });
    writeSearchTasks(root, [{ id: "ID-1", title: "Fix signal timeout", status: "done", type: "bug", priority: "high" }]);
    const result = await searchProject(root, { query: "signal timeout", sources: ["tasks", "code", "knowledge"] }, services);
    expect(result.hits.map(hit => hit.id)).toEqual(["tasks:ID-1"]);
    expect(result.notices.join(" ")).not.toContain("unavailable");
    expect(await import("node:fs").then(fs => fs.existsSync(path.join(root, ".indexer-cli")))).toBe(false);
  });

  test("native lexical retrieval returns both repository domains without external tools", async () => {
    const root = fixture();
    writeFileSync(path.join(root, "worker.ts"), "export const uniqueSearchNeedle = true;\n");
    writeFileSync(path.join(root, "guide.md"), "# Unique search\nuniqueSearchNeedle reference\n");
    const result = await searchProject(root, { query: "uniqueSearchNeedle", sources: ["code", "knowledge"], indexMode: "lexical", includeContent: true }, {});
    expect(result.hits.map(hit => hit.kind).sort()).toEqual(["code", "knowledge"]);
    expect(result.hits).toContainEqual(expect.objectContaining({ path: "worker.ts", startLine: 1 }));
    expect(existsSync(path.join(root, ".indexer-cli"))).toBe(false);
    expect(existsSync(path.join(root, ".pi/search/file-vectors.sqlite"))).toBe(false);
  });

  test("retired backend and structural filters are rejected rather than ignored", () => {
    for (const option of [{ indexBackend: "idx" }, { indexMode: "symbol" }, { chunkTypes: ["api"] },
      { minScore: 0.2 }, { includeImports: true }, { dedupeSymbol: true }, { cluster: true }]) {
      expect(parseProjectSearchParams({ query: "needle", ...option }).error).toBeDefined();
    }
  });

  test("one failed source does not hide successful sources or leak provider diagnostics", async () => {
    const root = fixture();
    const result = await searchProject(root, { query: "test", sources: ["sessions", "code"] }, {
      ...services,
      listSessions: async () => [{
        id: "s", cwd: root, path: "/sessions/s.jsonl", firstMessage: "test",
      }],
      readSession: async () => ({ firstText: "test message", finalText: "test reply" }),
      native: async () => { throw new Error("Bearer SECRET-CREDENTIAL provider debug"); },
    });
    expect(result.hits[0]?.id).toBe("sessions:s");
    expect(result.notices.join(" ")).toContain("Native Code/Knowledge unavailable");
    expect(JSON.stringify(result)).not.toContain("SECRET-CREDENTIAL");
  });

  test("the 60-second deadline settles even when a source ignores cancellation", async () => {
    const root = fixture();
    let expire!: () => void;
    const nativeSetTimeout = globalThis.setTimeout;
    const timer = spyOn(globalThis, "setTimeout").mockImplementation(((callback: () => void, ms: number) => {
      expect(ms).toBe(60_000);
      expire = callback;
      return nativeSetTimeout(callback, ms);
    }) as typeof setTimeout);
    try {
      const result = await searchProject(root, { query: "unused", sources: ["sessions"] }, {
        ...services,
        listSessions: async () => { expire(); return new Promise(() => {}); },
      });
      expect(result.notices).toContain("Some sources exceeded the 60-second search deadline.");
      expect(result.hits).toEqual([]);
    } finally {
      timer.mockRestore();
    }
  });

  test("cancellation settles even when an injected source ignores its AbortSignal", async () => {
    const root = fixture();
    let entered!: () => void;
    const ready = new Promise<void>(resolve => { entered = resolve; });
    const owner = new AbortController();
    const pending = searchProject(root, { query: "unused", sources: ["sessions"] }, {
      ...services, listSessions: async () => { entered(); return new Promise(() => {}); },
    }, owner.signal);
    await ready;
    owner.abort();
    await expect(pending).rejects.toThrow();
  });

  test("native Git finds changed file paths and supports explicit on-demand patch pickaxe", async () => {
    const root = fixture();
    const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
    git("init", "-q");
    git("config", "user.email", "test@example.com");
    git("config", "user.name", "Test");
    mkdirSync(path.join(root, "src"));
    writeFileSync(path.join(root, "src", "worker_abort.ts"), "const worker = 1;\n");
    git("add", "src/worker_abort.ts");
    git("commit", "-qm", "Neutral initial commit");
    writeFileSync(path.join(root, "src", "worker_abort.ts"), "const worker = 1;\nconst ABORT_HOOK_SENTINEL = 1;\n");
    git("add", "src/worker_abort.ts");
    git("commit", "-qm", "Neutral follow-up");
    const byPath = await searchProject(root, { query: "worker_abort", sources: ["commits"], limit: 2 }, services);
    expect(byPath.hits).toHaveLength(2);
    expect(byPath.hits.every(hit => hit.changedPaths?.includes("src/worker_abort.ts"))).toBe(true);
    expect(byPath.hits[0]?.hash).toMatch(/^[a-f0-9]{40}$/u);
    expect(byPath.hits[0]?.snippet).not.toContain("ABORT_HOOK_SENTINEL");
    const patch = await searchProject(root, { query: "patch:ABORT_HOOK_SENTINEL", sources: ["commits", "tasks"] }, services);
    expect(patch.sources).toEqual(["commits"]);
    expect(patch.hits).toHaveLength(1);
    expect(patch.hits[0]?.hash).toBe(git("rev-parse", "HEAD"));
    expect(patch.notices.join(" ")).toContain("other sources were skipped");
    expect(parseGitHistory("PIX-PROJECT-COMMIT:bad\0")).toEqual([]);
  });

  test.each(["posix", "win32"] as const)("inspects a substantially larger but explicitly bounded session history (%s paths)", async style => {
    const root = fixture();
    const sessionPaths = path[style];
    const sessions: SessionRecord[] = Array.from({ length: 1002 }, (_, i) => ({
      id: `session-${i}`, cwd: root, path: sessionPaths.join(root, `${i}.jsonl`),
      firstMessage: `First question number ${i}`, name: `Session ${i}`,
    }));
    const reads: string[] = [];
    const result = await searchProject(root, { query: "uniquelate999", sources: ["sessions"] }, {
      ...services,
      listSessions: async () => sessions,
      readSession: async filename => {
        reads.push(filename);
        // Use the fixture's path dialect, not a POSIX-only suffix, on every host.
        const basename = sessionPaths.basename(filename);
        return { firstText: basename === "999.jsonl" || basename === "1000.jsonl" ? "uniquelate999" : "ordinary", finalText: "" };
      },
    });
    expect(result.hits.map(hit => hit.sessionId)).toEqual(["session-999"]);
    expect(reads).toEqual(sessions.slice(0, 1000).map(session => session.path));
    expect(result.notices.join(" ")).toContain("1,000 most recent sessions");
  });

  test("Git search reaches beyond the old 1,000 commit cutoff and maintains bounded arguments", async () => {
    const root = fixture();
    const history = Array.from({ length: 1201 }, (_, i) => {
      const hash = i.toString(16).padStart(40, "0");
      return [
        `PIX-PROJECT-COMMIT:${hash}`, hash.slice(0, 7), i === 1150 ? "UniqueHistoricalMark" : `Older changes ${i}`,
        "Test author", "2026-10-10T00:00:00+00:00", "Recorded project change",
      ].join("\0") + "\0";
    }).join("");
    const result = await searchProject(root, { query: "UniqueHistoricalMark", sources: ["commits"] }, {
      ...services,
      git: async (_cwd, argv) => {
        expect(argv).toContain("--max-count=5000");
        expect(argv).not.toContain("--max-count=1000");
        return history;
      },
    });
    expect(result.hits).toHaveLength(1);
    expect(result.hits[0]?.title).toBe("UniqueHistoricalMark");
    expect(result.notices).toEqual([]);
  });
});

describe("project_search registration in Pix Desktop and TUI", () => {
  test("registers unconditionally, returns safe text + structured source references, and validates parameters", async () => {
    const root = fixture();
    mkdirSync(path.join(root, ".pi"), { recursive: true });
    writeSearchTasks(root, [{ id: "T-1", title: "Fix scheduler", type: "bug", status: "done", priority: "high" }]);
    const registered: Array<{ name: string; execute: Function; promptSnippet: string; parameters: Record<string, unknown> }> = [];
    const events: string[] = [];
    projectSearchExtension({
      registerTool: (tool: typeof registered[number]) => registered.push(tool),
      registerCommand: () => {},
      on: (event: string) => { events.push(event); },
    } as never);
    expect(registered.map(t => t.name)).toEqual(["project_search"]);
    expect(events).toEqual(["session_start", "session_shutdown", "session_start", "agent_start", "agent_end", "turn_end", "message_end", "session_tree", "session_shutdown", "session_start", "session_shutdown", "session_start", "session_shutdown"]);
    expect(registered[0]?.promptSnippet).toContain("No second LLM");
    const ok = await registered[0]!.execute("1", { query: "scheduler", sources: ["tasks"] },
      signal(), undefined, { cwd: root });
    expect(ok.isError).toBeUndefined();
    expect(ok.content[0].text).toContain("tasks:T-1");
    expect(ok.details.results).toMatchObject([{ kind: "tasks", taskId: "T-1" }]);
    const invalid = await registered[0]!.execute("2", { query: "scheduler", indexMode: "unsafe" }, signal(), undefined, { cwd: root });
    expect(invalid.isError).toBe(true);
    expect(invalid.details.valid).toBe(false);
  });

  test("the actual Pi SDK loads only project_search without external index setup", async () => {
    const root = fixture();
    const lookupPath = fileURLToPath(new URL("../src/project-search/index.ts", import.meta.url));
    const loader = new DefaultResourceLoader({
      cwd: root, agentDir: path.join(root, "agent"),
      settingsManager: SettingsManager.inMemory({ enableInstallTelemetry: false }),
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
      additionalExtensionPaths: [lookupPath],
    });
    try {
      await loader.reload();
      const loaded = loader.getExtensions();
      expect(loaded.errors).toEqual([]);
      const toolNames = loaded.extensions.flatMap(extension => [...extension.tools.keys()]);
      expect(toolNames).toContain("project_search");
      for (const name of ["repo_context", "repo_inspect", "repo_audit"]) expect(toolNames).not.toContain(name);
      expect(toolNames.filter(name => name === "project_search")).toHaveLength(1);
      expect(toolNames).not.toContain("repo_search");
      const tool = loaded.extensions[0]?.tools.get("project_search");
      const parameters = tool?.definition.parameters as unknown as { properties: Record<string, { enum?: string[]; maximum?: number }> };
      expect(parameters.properties.indexMode.enum).toEqual(["hybrid", "semantic", "lexical"]);
      expect(parameters.properties.maxFiles.maximum).toBe(50);
    } finally {
      loader.getExtensions().runtime.invalidate();
    }
  });
});
