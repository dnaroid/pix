import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";
import { installFakeIdxOnPath } from "./support/fake-idx.js";
import projectSearchExtension from "../src/project-search/index.js";
import {
  formatProjectSearch, indexSearchArgs, parseGitHistory, parseIdxHits, parseProjectSearchParams, readSessionBoundary,
  searchProject, type ProjectSearchServices, type SessionRecord,
} from "../src/project-search/engine.js";

const directories: string[] = [];
afterEach(() => {
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const fixture = () => {
  const root = mkdtempSync(path.join(tmpdir(), "pix-project-search-"));
  directories.push(root);
  return root;
};
const signal = () => new AbortController().signal;
const disabledIdx: ProjectSearchServices = {
  exec: async () => { throw new Error("IDX must not run"); },
  indexed: () => false,
  listSessions: async () => [],
};

describe("project_search shared store lookup", () => {
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
    for (const indexMode of ["hybrid", "semantic", "lexical", "symbol"]) {
      expect(parseProjectSearchParams({ query: "test", indexMode }).params?.indexMode).toBe(indexMode);
    }
    expect(parseProjectSearchParams({ query: "test", maxFiles: 50 }).params?.maxFiles).toBe(50);
  });

  test("searches saved project tasks and session first/final excerpts, never tool bodies", async () => {
    const root = fixture();
    mkdirSync(path.join(root, ".pi"));
    writeFileSync(path.join(root, ".pi", "tasks.jsonc"), `{
      // Same storage as Desktop Tasks
      "version": 1,
      "tasks": [
        { "id": "TASK-42", "title": "Resolve semaphore race", "description": "Cancel pending requests",
          "status": "done", "type": "bug", "priority": "high" },
        { "id": "TASK-43", "title": "Unrelated documentation", "description": "Write a README",
          "status": "todo", "type": "feature", "priority": "low" },
      ],
    }`);
    const sessions: SessionRecord[] = [
      { id: "session-1", cwd: root, path: "/sessions/native-1.jsonl", name: "Architecture review", firstMessage: "question" },
      { id: "session-other", cwd: "/other/project", path: "/sessions/other.jsonl", firstMessage: "race" },
    ];
    let calls = 0;
    const result = await searchProject(root, { query: "semaphore race", sources: ["sessions", "tasks"] }, {
      ...disabledIdx,
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

  test("an explicitly selected alternate project changes scope but never the session cwd", async () => {
    const sessionRoot = fixture();
    const other = fixture();
    mkdirSync(path.join(sessionRoot, ".pi"));
    mkdirSync(path.join(other, ".pi"));
    writeFileSync(path.join(sessionRoot, ".pi", "tasks.jsonc"), JSON.stringify({
      version: 1, tasks: [{ id: "OLD", title: "Existing client", type: "feature", status: "done", priority: "low" }],
    }));
    writeFileSync(path.join(other, ".pi", "tasks.jsonc"), JSON.stringify({
      version: 1, tasks: [{ id: "NEW", title: "Alternate project target", type: "bug", status: "todo", priority: "high" }],
    }));
    const response = await searchProject(sessionRoot, {
      query: "alternate project", sources: ["tasks"],
      projectPath: path.relative(sessionRoot, other),
    }, disabledIdx);
    expect(response.projectRoot).toBe(await realpath(other));
    expect(response.hits.map(hit => hit.id)).toEqual(["tasks:NEW"]);
    const same = await searchProject(sessionRoot, { query: "existing client", sources: ["tasks"] }, disabledIdx);
    expect(same.projectRoot).toBe(await realpath(sessionRoot));
    expect(same.hits.map(hit => hit.id)).toEqual(["tasks:OLD"]);
  });

  test("rejects redirected task storage and continues searching other sources without reading it", async () => {
    const root = fixture(), external = fixture();
    mkdirSync(path.join(external, ".pi"));
    writeFileSync(path.join(external, ".pi", "tasks.jsonc"), JSON.stringify({
      version: 1, tasks: [{ id: "secret", title: "Secret Access", status: "todo" }],
    }));
    const { symlinkSync } = await import("node:fs");
    symlinkSync(path.join(external, ".pi"), path.join(root, ".pi"));
    const response = await searchProject(root, { query: "secret", sources: ["tasks", "sessions"] },
      { ...disabledIdx, listSessions: async () => [] });
    expect(response.hits).toEqual([]);
  });

  test("isolates missing IDX from local sources without automatically creating an index", async () => {
    const root = fixture();
    mkdirSync(path.join(root, ".pi"));
    writeFileSync(path.join(root, ".pi", "tasks.jsonc"), JSON.stringify({
      version: 1, tasks: [{ id: "ID-1", title: "Fix signal timeout", status: "done", type: "bug", priority: "high" }],
    }));
    const result = await searchProject(root, { query: "signal timeout", sources: ["tasks", "code", "knowledge"] }, disabledIdx);
    expect(result.hits.map(hit => hit.id)).toEqual(["tasks:ID-1"]);
    expect(result.notices.join(" ")).toContain("No initialization was performed");
    expect(await import("node:fs").then(fs => fs.existsSync(path.join(root, ".indexer-cli")))).toBe(false);
  });

  test("reuses IDX for code/docs, with explicit lexical mode and navigable file ranges", async () => {
    const root = fixture();
    const calls: string[][] = [];
    const code = "src/main.ts:12-20 (score: 0.94, rank=1, domain=code)\n  kind=function\nContent: 2 lines\nreturn abort();\n// no tool run\n";
    const docs = "docs/decision.md:3-7 (score: 0.83, rank=1, domain=document)\nContent: 1 lines\nWe migrated from polling\n";
    const result = await searchProject(root, { query: "abort", sources: ["code", "knowledge"], indexMode: "lexical" }, {
      ...disabledIdx,
      indexed: () => true,
      exec: async (command, args) => {
        expect(command).toBe("idx");
        calls.push(args);
        return { stdout: args.includes("code") ? code : docs, stderr: "", code: 0 };
      },
    });
    expect(calls).toHaveLength(2);
    expect(calls.every(args => args.includes("--domain") && args.includes("lexical")
      && !args.includes("--include-content") && args[0] === "search")).toBe(true);
    expect(result.hits.map(hit => hit.id)).toEqual(["code:src/main.ts:12-20", "knowledge:docs/decision.md:3-7"]);
    expect(result.hits[0]).toMatchObject({ path: "src/main.ts", startLine: 12, endLine: 20 });
    expect(result.hits[1]).toMatchObject({ path: "docs/decision.md", startLine: 3, endLine: 7 });
    expect(parseIdxHits("../../../outside.ts:1-2 (score: 0.9, rank=1, domain=code)", "code")).toEqual([]);
    expect(parseIdxHits("/private/file.ts:1-2 (score: 0.9, rank=1, domain=code)", "code")).toEqual([]);
    expect(parseIdxHits("src/legit.ts:1-2 (score: 0.9, rank=1, domain=document)", "code")).toEqual([]);
    expect(parseIdxHits(
      "src/real.ts:10-11 (score: 0.9, rank=1, domain=code)\nContent: 2 lines\n"+
      "src/fake.ts:1-1 (score: 1.00, rank=1, domain=code)\nbody text\n",
      "code",
    ).map(hit => hit.path)).toEqual(["src/real.ts"], "header-shaped IDX body text must not create additional hits");
  });

  test("migrates all focused IDX search filters into strongly typed project_search arguments", async () => {
    const root = fixture();
    const calls: string[][] = [];
    const result = await searchProject(root, {
      query: "createSession", sources: ["code"], indexMode: "symbol",
      pathPrefix: "src/components", maxFiles: 7,
      chunkTypes: ["api", "impl"], minScore: 0.4,
      includeContent: true, includeImports: true, dedupeFile: true, dedupeSymbol: true,
      cluster: true, excludeTests: true,
    }, {
      ...disabledIdx, indexed: () => true,
      exec: async (command, argv) => {
        expect(command).toBe("idx");
        calls.push(argv);
        return { stdout: "src/components/Session.ts:8-13 (score: 0.92, rank=symbol, domain=code)\nContent: 1 lines\nexport const createSession = () => {}\n",
          stderr: "", code: 0 };
      },
    });
    expect(calls).toEqual([[
      "search", "createSession", "--domain", "code", "--mode", "symbol", "--max-files", "7",
      "--path-prefix", "src/components", "--chunk-types", "api,impl", "--min-score", "0.4",
      "--include-content", "--include-imports", "--dedupe-file", "--dedupe-symbol", "--cluster", "--exclude-tests",
    ]]);
    expect(result.hits).toMatchObject([{ id: "code:src/components/Session.ts:8-13",
      path: "src/components/Session.ts", startLine: 8, endLine: 13 }]);
    expect(indexSearchArgs("abc", "knowledge", { indexMode: "semantic", includeTests: true }))
      .toEqual(["search", "abc", "--domain", "document", "--mode", "semantic", "--max-files", "3", "--include-tests"]);
    expect(indexSearchArgs("abc", "code", { includeContent: true }))
      .toEqual(["search", "abc", "--domain", "code", "--mode", "hybrid", "--max-files", "1", "--include-content"]);
  });

  test("one failed source does not hide successful sources or leak provider diagnostics", async () => {
    const root = fixture();
    const result = await searchProject(root, { query: "test", sources: ["sessions", "code"] }, {
      ...disabledIdx,
      indexed: () => true,
      listSessions: async () => [{
        id: "s", cwd: root, path: "/sessions/s.jsonl", firstMessage: "test",
      }],
      readSession: async () => ({ firstText: "test message", finalText: "test reply" }),
      exec: async () => { throw new Error("Bearer SECRET-CREDENTIAL provider debug"); },
    });
    expect(result.hits[0]?.id).toBe("sessions:s");
    expect(result.notices.join(" ")).toContain("IDX query unavailable");
    expect(JSON.stringify(result)).not.toContain("SECRET-CREDENTIAL");
  });

  test("cancellation settles even when an injected source ignores its AbortSignal", async () => {
    const root = fixture();
    let entered!: () => void;
    const ready = new Promise<void>(resolve => { entered = resolve; });
    const owner = new AbortController();
    const pending = searchProject(root, { query: "unused", sources: ["sessions"] }, {
      ...disabledIdx, listSessions: async () => { entered(); return new Promise(() => {}); },
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
    const byPath = await searchProject(root, { query: "worker_abort", sources: ["commits"], limit: 2 }, disabledIdx);
    expect(byPath.hits).toHaveLength(2);
    expect(byPath.hits.every(hit => hit.changedPaths?.includes("src/worker_abort.ts"))).toBe(true);
    expect(byPath.hits[0]?.hash).toMatch(/^[a-f0-9]{40}$/u);
    expect(byPath.hits[0]?.snippet).not.toContain("ABORT_HOOK_SENTINEL");
    const patch = await searchProject(root, { query: "patch:ABORT_HOOK_SENTINEL", sources: ["commits", "tasks"] }, disabledIdx);
    expect(patch.sources).toEqual(["commits"]);
    expect(patch.hits).toHaveLength(1);
    expect(patch.hits[0]?.hash).toBe(git("rev-parse", "HEAD"));
    expect(patch.notices.join(" ")).toContain("other sources were skipped");
    expect(parseGitHistory("PIX-PROJECT-COMMIT:bad\0")).toEqual([]);
  });
});

describe("project_search registration in Pix Desktop and TUI", () => {
  test("registers unconditionally, returns safe text + structured source references, and validates parameters", async () => {
    const root = fixture();
    mkdirSync(path.join(root, ".pi"));
    writeFileSync(path.join(root, ".pi", "tasks.jsonc"), JSON.stringify({
      version: 1, tasks: [{ id: "T-1", title: "Fix scheduler", type: "bug", status: "done", priority: "high" }],
    }));
    const registered: Array<{ name: string; execute: Function; promptSnippet: string; parameters: Record<string, unknown> }> = [];
    projectSearchExtension({
      registerTool: (tool: typeof registered[number]) => registered.push(tool),
      exec: async () => { throw new Error("Remote IDX must not be used for tasks-only search"); },
    } as never);
    expect(registered.map(t => t.name)).toEqual(["project_search"]);
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

  test("the actual Pi SDK loads project_search and the retained repo tools without a repo_search alias", async () => {
    const root = fixture();
    const lookupPath = fileURLToPath(new URL("../src/project-search/index.ts", import.meta.url));
    const discoveryPath = fileURLToPath(new URL("../src/repo-discovery/index.ts", import.meta.url));
    // Repo tools register only when the registering process runs inside an
    // indexed project with idx on PATH; the path-based SDK loader passes no
    // extension options, so that gate reads process.cwd(). Seed both
    // conditions hermetically instead of relying on developer-machine state.
    const gateMarker = path.join(process.cwd(), ".indexer-cli");
    const gateMarkerExisted = existsSync(gateMarker);
    mkdirSync(gateMarker, { recursive: true });
    const restorePath = installFakeIdxOnPath(root);
    const loader = new DefaultResourceLoader({
      cwd: root, agentDir: path.join(root, "agent"),
      settingsManager: SettingsManager.inMemory({ enableInstallTelemetry: false }),
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
      additionalExtensionPaths: [lookupPath, discoveryPath],
    });
    try {
      await loader.reload();
      const loaded = loader.getExtensions();
      expect(loaded.errors).toEqual([]);
      const toolNames = loaded.extensions.flatMap(extension => [...extension.tools.keys()]);
      expect(toolNames).toContain("project_search");
      expect(toolNames).toContain("repo_context");
      expect(toolNames).toContain("repo_inspect");
      expect(toolNames.filter(name => name === "project_search")).toHaveLength(1);
      expect(toolNames).not.toContain("repo_search");
      const tool = loaded.extensions[0]?.tools.get("project_search");
      const parameters = tool?.definition.parameters as unknown as { properties: Record<string, { enum?: string[]; maximum?: number }> };
      expect(parameters.properties.indexMode.enum).toEqual(["hybrid", "semantic", "lexical", "symbol"]);
      expect(parameters.properties.maxFiles.maximum).toBe(50);
    } finally {
      loader.getExtensions().runtime.invalidate();
      restorePath();
      if (!gateMarkerExisted) rmSync(gateMarker, { recursive: true, force: true });
    }
  });
});
