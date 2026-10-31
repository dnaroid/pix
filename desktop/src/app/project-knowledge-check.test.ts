import { beforeEach, describe, expect, it, vi } from "vitest";
import { createProjectDocumentsStore } from "./project-documents.svelte";
import type { KnowledgeCheckRequest, KnowledgeCheckResult } from "../../../acp/src/knowledge/contract";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  readWorkspaceConfig: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("./workspace-config-persistence", () => ({ readWorkspaceConfig: mocks.readWorkspaceConfig }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => { resolve = yes; });
  return { promise, resolve };
}

function wikiConfig(path: string) {
  return { content: JSON.stringify({ wiki: { path } }) };
}

function clearResult(path: string): KnowledgeCheckResult {
  return {
    status: "clear", path, documentHash: "draft-hash", modelRef: "test/model",
    checkedSources: 2, conflicts: [], notices: [],
  };
}

function fixture(path = "wiki/retries.md", connected = true) {
  let workspace = "/project";
  let file: { path: string; content: string } | undefined = { path, content: "Saved source" };
  const checkKnowledge = vi.fn(async (request: KnowledgeCheckRequest, _signal: AbortSignal) => clearResult(request.path));
  const afterSave = vi.fn();
  const store = createProjectDocumentsStore({
    workspace: () => workspace,
    openProjectFile: vi.fn(),
    showEmptyFile: vi.fn(),
    previewId: () => 7,
    currentFile: () => file,
    afterSave,
    clearError: vi.fn(),
    reportError: vi.fn(),
    ...(connected ? { checkKnowledge } : {}),
  });
  return {
    store, checkKnowledge, afterSave,
    changeWorkspace: () => { workspace = "/another-project"; },
    setCurrentFile: (next: typeof file) => { file = next; },
  };
}

beforeEach(() => {
  mocks.invoke.mockReset();
  mocks.readWorkspaceConfig.mockReset().mockResolvedValue(null);
});

describe("project Wiki consistency routing", () => {
  it.each(["md", "markdown"])("checks a custom Wiki .%s draft with its loaded expected content", async (extension) => {
    const path = `docs/knowledge/retries.${extension}`;
    mocks.readWorkspaceConfig.mockResolvedValue(wikiConfig("docs/knowledge"));
    const { store, checkKnowledge, afterSave } = fixture(path);
    const controller = new AbortController();

    const result = await store.checkKnowledge(path, "New draft assertion", controller.signal);

    expect(mocks.readWorkspaceConfig).toHaveBeenCalledTimes(1);
    expect(mocks.readWorkspaceConfig).toHaveBeenCalledWith("/project");
    expect(checkKnowledge).toHaveBeenCalledTimes(1);
    expect(checkKnowledge).toHaveBeenCalledWith({
      cwd: "/project", path, content: "New draft assertion", expectedContent: "Saved source",
    }, controller.signal);
    expect(result).toBe(await checkKnowledge.mock.results[0]!.value);
    expect(store.wikiPath).toBe("docs/knowledge");
    expect(afterSave).not.toHaveBeenCalled();
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("does not attach another document's content to a new Wiki page check", async () => {
    const { store, checkKnowledge, setCurrentFile } = fixture("wiki/existing.md");
    const signal = new AbortController().signal;

    await store.checkKnowledge("wiki/new.md", "New page", signal);
    expect(checkKnowledge).toHaveBeenLastCalledWith({ cwd: "/project", path: "wiki/new.md", content: "New page" }, signal);

    setCurrentFile(undefined);
    await store.checkKnowledge("wiki/another.md", "Another page", signal);
    expect(checkKnowledge).toHaveBeenLastCalledWith({ cwd: "/project", path: "wiki/another.md", content: "Another page" }, signal);
  });

  it("skips Markdown outside the configured Wiki and non-Markdown files inside it", async () => {
    mocks.readWorkspaceConfig.mockResolvedValue(wikiConfig("docs/knowledge"));
    const { store, checkKnowledge } = fixture();
    const signal = new AbortController().signal;

    for (const path of ["README.md", "wiki/page.md", "docs/knowledge-old/page.md", "docs/knowledge.md"]) {
      expect(await store.checkKnowledge(path, "Unrelated draft", signal)).toBeUndefined();
    }
    expect(mocks.readWorkspaceConfig).toHaveBeenCalledTimes(4);
    mocks.readWorkspaceConfig.mockClear();

    for (const path of ["docs/knowledge/image.png", "docs/knowledge/notes.txt", "docs/knowledge/page.mdx"]) {
      expect(await store.checkKnowledge(path, "Asset", signal)).toBeUndefined();
    }
    expect(mocks.readWorkspaceConfig).not.toHaveBeenCalled();
    expect(checkKnowledge).not.toHaveBeenCalled();
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("rereads Wiki configuration before every check, including previously eligible paths", async () => {
    const { store, checkKnowledge } = fixture("wiki/retries.md");
    const signal = new AbortController().signal;
    mocks.readWorkspaceConfig.mockResolvedValueOnce(null)
      .mockResolvedValueOnce(wikiConfig("docs/reference"))
      .mockResolvedValueOnce(wikiConfig("docs/reference"));

    expect(await store.checkKnowledge("wiki/retries.md", "First draft", signal)).toMatchObject({ status: "clear" });
    expect(await store.checkKnowledge("wiki/retries.md", "Second draft", signal)).toBeUndefined();
    expect(await store.checkKnowledge("docs/reference/retries.md", "Third draft", signal)).toMatchObject({ status: "clear" });

    expect(mocks.readWorkspaceConfig).toHaveBeenCalledTimes(3);
    expect(checkKnowledge).toHaveBeenCalledTimes(2);
    expect(checkKnowledge.mock.calls.map(([request]) => request.path)).toEqual(["wiki/retries.md", "docs/reference/retries.md"]);
    expect(store.wikiPath).toBe("docs/reference");
  });

  it("rejects a Wiki check when the project backend is unavailable", async () => {
    const { store, checkKnowledge } = fixture("wiki/retries.md", false);

    await expect(store.checkKnowledge("wiki/retries.md", "Draft", new AbortController().signal)).rejects.toThrow(/unavailable/i);

    expect(checkKnowledge).not.toHaveBeenCalled();
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("rejects invalid Wiki configuration instead of silently skipping a check", async () => {
    const { store, checkKnowledge } = fixture();
    for (const content of ["{ invalid jsonc", JSON.stringify({ wiki: { path: "../outside" } })]) {
      mocks.readWorkspaceConfig.mockResolvedValue({ content });
      await expect(store.checkKnowledge("wiki/retries.md", "Draft", new AbortController().signal)).rejects.toThrow();
    }
    expect(checkKnowledge).not.toHaveBeenCalled();
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it.each([
    { boundary: "configuration", invalidation: "cancellation" },
    { boundary: "backend", invalidation: "cancellation" },
    { boundary: "configuration", invalidation: "workspace reset" },
    { boundary: "backend", invalidation: "workspace reset" },
    { boundary: "backend", invalidation: "workspace change" },
  ] as const)("discards a late $boundary response after $invalidation", async ({ boundary, invalidation }) => {
    const path = "docs/knowledge/retries.md";
    const config = deferred<ReturnType<typeof wikiConfig>>();
    const backend = deferred<KnowledgeCheckResult>();
    const backendStarted = deferred<boolean>();
    mocks.readWorkspaceConfig.mockReturnValue(config.promise);
    const { store, checkKnowledge, changeWorkspace } = fixture(path);
    checkKnowledge.mockImplementation(() => { backendStarted.resolve(true); return backend.promise; });
    const controller = new AbortController();
    const pending = store.checkKnowledge(path, "Draft", controller.signal);
    const rejected = expect(pending).rejects.toThrow(invalidation === "cancellation" ? "Cancelled by editor" : /project changed/i);

    if (boundary === "backend") {
      config.resolve(wikiConfig("docs/knowledge"));
      await backendStarted.promise;
      expect(checkKnowledge).toHaveBeenCalledTimes(1);
    }

    if (invalidation === "cancellation") controller.abort(new Error("Cancelled by editor"));
    else if (invalidation === "workspace reset") store.reset();
    else changeWorkspace();

    if (boundary === "configuration") config.resolve(wikiConfig("docs/knowledge"));
    else backend.resolve(clearResult(path));

    await rejected;
    expect(checkKnowledge).toHaveBeenCalledTimes(boundary === "configuration" ? 0 : 1);
    if (invalidation === "workspace reset" || boundary === "configuration") expect(store.wikiPath).toBe("wiki");
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});
