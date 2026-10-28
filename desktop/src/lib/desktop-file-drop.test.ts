import { afterEach, describe, expect, it, vi } from "vitest";
import { installDesktopFileDrop, PROJECT_FILE_DROP_EVENT, PROJECT_FILE_HOVER_EVENT, startProjectFileDrag, type ProjectFileDrop } from "./desktop-file-drop";
import { invoke } from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
const reference = JSON.stringify({ format: "pix-project-entry", version: 2, workspace: "/", operation: "copy", entries: [{ path: "project/file #%.txt", kind: "file" }, { path: "outside/folder", kind: "directory" }] });
const settle = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
const cleanups: (() => void)[] = [];

function fixture() {
  let workspace = "/project";
  let session: string | null = "session";
  let question: string | null = null;
  let hit: "composer" | "folder" | "file" | "background" | "search" = "composer";
  const panel = Object.assign(new EventTarget(), { dataset: { projectWorkspace: workspace } });
  const folder = { dataset: { projectMoveTarget: "target" } };
  const doc = Object.assign(new EventTarget(), { elementFromPoint: () => ({ closest: (selector: string) => {
    if (selector === "[data-project-explorer]") return hit === "composer" ? null : panel;
    if (selector === "[data-project-move-row]") return hit === "folder" ? folder : hit === "file" ? { dataset: {} } : null;
    if (selector === "[data-project-move-target]" && hit === "background") return { dataset: { projectMoveTarget: "" } };
    return null;
  } }) });
  vi.stubGlobal("document", doc);
  const options = {
    workspace: () => workspace, sessionId: () => session, questionId: () => question,
    canAcceptAttachments: () => true, canInsertPromptPaths: () => true,
    setDragActive: vi.fn(), addQuestionPaths: vi.fn(), insertPromptPaths: vi.fn(), reportError: vi.fn(),
    read: vi.fn(async (): Promise<{ reference: string; source?: { workspace: string; paths: string[] } }> => ({ reference })),
  };
  const drops: ProjectFileDrop[] = [];
  const hovers: (string | null)[] = [];
  panel.addEventListener(PROJECT_FILE_DROP_EVENT, (event) => drops.push((event as CustomEvent<ProjectFileDrop>).detail));
  panel.addEventListener(PROJECT_FILE_HOVER_EVENT, (event) => hovers.push((event as CustomEvent<string | null>).detail));
  const dispose = installDesktopFileDrop(options);
  cleanups.push(dispose);
  function fire(type: string, cmd = false, types = ["Files"]) {
    const event = new Event(type, { cancelable: true });
    const transfer = { types, dropEffect: "none" };
    Object.assign(event, { dataTransfer: transfer, metaKey: cmd, clientX: 10, clientY: 20 });
    doc.dispatchEvent(event);
    return { event, transfer };
  }
  return { options, drops, hovers, fire, dispose, hit: (value: typeof hit) => { hit = value; }, workspace: (value: string) => { workspace = value; }, session: (value: string) => { session = value; }, question: (value: string) => { question = value; } };
}

afterEach(() => { cleanups.splice(0).forEach((dispose) => dispose()); vi.unstubAllGlobals(); vi.clearAllMocks(); });

describe("standard file drop routing", () => {
  it("copies Finder files into a hovered folder and captures Cmd for move before async work", async () => {
    const f = fixture();
    f.hit("folder");
    expect(f.fire("dragenter").transfer.dropEffect).toBe("copy");
    expect(f.hovers).toEqual(["target"]);
    f.fire("drop", true);
    expect(f.drops[0]?.destination).toBe("target");
    expect(f.drops[0]?.operation).toBe("move");
    expect((await f.drops[0]!.reference).reference.entries).toHaveLength(2);
    expect(f.options.insertPromptPaths).not.toHaveBeenCalled();
    expect(f.options.read).toHaveBeenCalledTimes(1);
    expect(f.hovers.at(-1)).toBeNull();
  });
  it("accepts tree background as root, rejects file rows and search without attaching to chat", () => {
    const f = fixture();
    f.hit("file");
    expect(f.fire("dragover").transfer.dropEffect).toBe("none");
    f.fire("drop");
    f.hit("search"); f.fire("drop");
    expect(f.drops).toHaveLength(0);
    expect(f.options.insertPromptPaths).not.toHaveBeenCalled();
    f.hit("background"); f.fire("drop");
    expect(f.drops[0]?.destination).toBe("");
    expect(f.drops[0]?.operation).toBe("copy");
  });
  it("keeps Finder -> composer and question drops non-destructive, even with Cmd", async () => {
    const f = fixture();
    expect(f.fire("dragover", true).transfer.dropEffect).toBe("copy");
    f.fire("drop", true);
    await settle();
    expect(f.options.insertPromptPaths).toHaveBeenCalledWith(["/project/file #%.txt", "/outside/folder"]);
    f.question("question"); f.fire("drop", true);
    await settle();
    expect(f.options.addQuestionPaths).toHaveBeenCalledWith("question", ["/project/file #%.txt", "/outside/folder"]);
    expect(f.drops).toHaveLength(0);
  });
  it("preserves Files -> Files move and Files -> composer relative references", async () => {
    const native = deferred<void>();
    vi.mocked(invoke).mockReturnValue(native.promise);
    const dragging = startProjectFileDrag("/project", ["file #%.txt"]);
    const f = fixture();
    f.options.read.mockResolvedValue({ reference, source: { workspace: "/project", paths: ["file #%.txt"] } });
    f.hit("folder");
    expect(f.fire("dragover").transfer.dropEffect).toBe("move");
    f.fire("drop");
    expect(f.drops[0]?.operation).toBe("move");
    f.hit("composer"); f.fire("drop", true);
    await settle();
    expect(f.options.insertPromptPaths).toHaveBeenCalledWith(["file #%.txt"]);
    native.resolve(); await dragging;
  });
  it("reads only committed drops, not nested or cancelled hover events", () => {
    const f = fixture();
    f.fire("dragenter"); f.fire("dragenter"); f.fire("dragleave"); f.fire("dragover");
    expect(f.options.read).not.toHaveBeenCalled();
    f.fire("dragleave");
    expect(f.options.setDragActive).toHaveBeenLastCalledWith(false);
    f.fire("dragenter");
    expect(f.options.read).not.toHaveBeenCalled();
    f.fire("drop");
    expect(f.options.read).toHaveBeenCalledTimes(1);
  });
  it("uses immutable native origin for composer refs even after the OS source has completed", async () => {
    vi.mocked(invoke).mockResolvedValue(undefined);
    await startProjectFileDrag("/project", ["file #%.txt"]);
    const f = fixture();
    f.options.read.mockResolvedValue({ reference, source: { workspace: "/project", paths: ["file #%.txt"] } });
    f.fire("drop", true); await settle();
    expect(f.options.insertPromptPaths).toHaveBeenCalledWith(["file #%.txt"]);
  });
  it("cancels pending filesystem preparation on pointer cancellation and removes the abort listener", async () => {
    const native = deferred<void>();
    vi.mocked(invoke).mockImplementation((command) => command === "start_project_entry_drag" ? native.promise : Promise.resolve());
    const abort = new AbortController();
    const dragging = startProjectFileDrag("/project", ["file"], abort.signal);
    abort.abort();
    expect(invoke).toHaveBeenCalledWith("cancel_project_entry_drag", { dragId: expect.any(String) });
    native.resolve(); await dragging;
    vi.mocked(invoke).mockClear(); abort.abort();
    expect(invoke).not.toHaveBeenCalled();
  });
  it("ignores late attachment completions after session change or disposal and removes listeners", async () => {
    const f = fixture();
    const read = deferred<{ reference: string }>(); f.options.read.mockReturnValue(read.promise);
    f.fire("drop"); f.session("another"); read.resolve({ reference }); await settle();
    expect(f.options.insertPromptPaths).not.toHaveBeenCalled();
    const second = deferred<{ reference: string }>(); f.options.read.mockReturnValue(second.promise);
    f.fire("drop"); f.dispose(); second.resolve({ reference }); await settle();
    expect(f.options.insertPromptPaths).not.toHaveBeenCalled();
    f.fire("drop");
    expect(f.options.read).toHaveBeenCalledTimes(2);
  });
  it("reports a failed drop but not an abandoned hover and ignores ordinary text drags", async () => {
    const f = fixture();
    f.fire("drop", false, ["text/plain"]);
    expect(f.options.read).not.toHaveBeenCalled();
    const error = new Error("unavailable drag"); f.options.read.mockRejectedValue(error);
    f.fire("dragenter"); f.fire("dragleave"); await settle();
    expect(f.options.reportError).not.toHaveBeenCalled();
    f.fire("drop"); await settle();
    expect(f.options.reportError).toHaveBeenCalledWith(error);
  });
});
