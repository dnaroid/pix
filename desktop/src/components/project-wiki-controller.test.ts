import { describe, expect, it, vi } from "vitest";
import type { ProjectFilePreview } from "../lib/project-files";
import { createProjectWikiController, STARTER_WIKI_INDEX } from "./project-wiki-controller.svelte";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => { resolve = yes; });
  return { promise, resolve };
}

function fixture(source?: string) {
  const directories = new Set<string>();
  const files = new Map<string, string>();
  const send = vi.fn(async (command: string, args: Record<string, unknown>): Promise<unknown> => {
    const path = String(args.path ?? "");
    if (command === "project_directory_exists") return directories.has(path);
    if (command === "project_file_exists") return files.has(path);
    if (command === "create_project_entry") {
      const created = args.parent ? `${String(args.parent)}/${String(args.name)}` : String(args.name);
      if (directories.has(created) || files.has(created)) throw new Error("Already exists");
      if (args.kind === "directory") directories.add(created);
      else files.set(created, "");
      return { path: created, name: args.name, kind: args.kind };
    }
    if (command === "list_project_directory") {
      const children = [...directories, ...files.keys()].filter((entry) => entry.slice(0, entry.lastIndexOf("/")) === path);
      return children.map((entry) => ({ path: entry, name: entry.slice(entry.lastIndexOf("/") + 1), kind: directories.has(entry) ? "directory" : "file" }));
    }
    if (command === "read_project_file") {
      if (!files.has(path)) throw new Error("Missing file");
      return { path, content: files.get(path) };
    }
    if (command === "write_project_file") {
      if (files.get(path) !== args.expectedContent) throw new Error("Changed while editing");
      files.set(path, String(args.content));
      return { path, content: args.content };
    }
    throw new Error(`Unexpected command: ${command}`);
  });
  const readConfig = vi.fn(async (): Promise<ProjectFilePreview | undefined> => source === undefined ? undefined : { path: ".pi/workspace.jsonc", content: source });
  const release = vi.fn();
  const prepare = vi.fn(async (): Promise<() => void> => release);
  const report = vi.fn();
  const controller = createProjectWikiController({
    send: send as <T>(command: string, args: Record<string, unknown>) => Promise<T>,
    readConfig, prepare, report,
  });
  return { controller, directories, files, send, readConfig, prepare, release, report };
}

describe("project Wiki lifecycle", () => {
  it("reads defaults without creating files, then initializes only on request", async () => {
    const f = fixture();
    await f.controller.selectWorkspace("/game");
    expect(f.controller.state).toMatchObject({ exists: false, indexExists: false, config: { path: "wiki", indexPath: "wiki/index.md" } });
    expect(f.send.mock.calls.every(([command]) => command.endsWith("_exists"))).toBe(true);
    expect(await f.controller.initialize()).toBe("wiki/index.md");
    expect(f.files.get("wiki/index.md")).toContain("# Project wiki");
    expect(f.release).toHaveBeenCalledOnce();
    expect(f.controller.state.starter).toBe(true);
    f.controller.dispose();
  });

  it("offers migration only while the Wiki holds nothing but the untouched starter index", async () => {
    const f = fixture('{"wiki":{"path":"docs/game","index":"overview/home.md"}}');
    for (const directory of ["docs", "docs/game", "docs/game/overview"]) f.directories.add(directory);
    f.files.set("docs/game/overview/home.md", `<!-- pix:wiki-report {} -->\r\n${STARTER_WIKI_INDEX.replaceAll("\n", "\r\n")}`);
    f.files.set("docs/game/.DS_Store", "");
    await f.controller.selectWorkspace("/game");
    expect(f.controller.state.starter).toBe(true);

    f.files.set("docs/game/overview/rules.md", "# Rules\n");
    await f.controller.refresh();
    expect(f.controller.state.starter).toBe(false);

    f.files.delete("docs/game/overview/rules.md");
    f.files.set("docs/game/overview/home.md", "# Game\n\nAuthored.\n");
    await f.controller.refresh();
    expect(f.controller.state.starter).toBe(false);
    f.controller.dispose();
  });

  it("does not offer migration when initialization adds an index beside existing pages", async () => {
    const f = fixture();
    f.directories.add("wiki");
    f.files.set("wiki/notes.md", "# Notes\n");
    await f.controller.selectWorkspace("/game");
    expect(await f.controller.initialize()).toBe("wiki/index.md");
    expect(f.controller.state.starter).toBe(false);
    f.controller.dispose();
  });

  it("creates nested configured parents and never rewrites an existing index", async () => {
    const f = fixture('{"wiki":{"path":"docs/game","index":"overview/home.md"}}');
    await f.controller.selectWorkspace("/game");
    await f.controller.initialize();
    expect([...f.directories]).toEqual(["docs", "docs/game", "docs/game/overview"]);
    f.files.set("docs/game/overview/home.md", "authored elsewhere");
    f.send.mockClear();
    await f.controller.initialize();
    expect(f.files.get("docs/game/overview/home.md")).toBe("authored elsewhere");
    expect(f.send.mock.calls.some(([command]) => command === "write_project_file")).toBe(false);
    f.controller.dispose();
  });

  it("surfaces malformed configuration and refuses initialization", async () => {
    const f = fixture('{"wiki":{"path":"../elsewhere"}}');
    await f.controller.selectWorkspace("/game");
    expect(f.controller.state.config).toBeNull();
    expect(f.controller.state.error).toBeTruthy();
    expect(await f.controller.initialize()).toBeUndefined();
    expect(f.send).not.toHaveBeenCalled();
    expect(f.report).toHaveBeenCalledOnce();
    f.controller.dispose();
  });

  it("ignores an old workspace config and coalesces refreshes", async () => {
    const f = fixture();
    const oldConfig = deferred<ProjectFilePreview | undefined>();
    f.readConfig.mockReturnValueOnce(oldConfig.promise);
    const oldLoad = f.controller.selectWorkspace("/old");
    const firstRefresh = f.controller.refresh();
    const secondRefresh = f.controller.refresh();
    expect(firstRefresh).toBe(secondRefresh);
    await f.controller.selectWorkspace("/new");
    oldConfig.resolve({ path: ".pi/workspace.jsonc", content: '{"wiki":{"path":"old-wiki"}}' });
    await oldLoad;
    expect(f.controller.state.config?.path).toBe("wiki");
    expect(f.send.mock.calls.every(([, args]) => args.workspace === "/new")).toBe(true);
    f.controller.dispose();
  });

  it("stops initialization after disposal and releases the mutation reservation", async () => {
    const f = fixture();
    await f.controller.selectWorkspace("/game");
    const preparing = deferred<() => void>();
    f.prepare.mockReturnValueOnce(preparing.promise);
    f.send.mockClear();
    const pending = f.controller.initialize();
    f.controller.dispose();
    preparing.resolve(f.release);
    expect(await pending).toBeUndefined();
    expect(f.send).not.toHaveBeenCalled();
    expect(f.release).toHaveBeenCalledOnce();
  });

  it("does not continue creating in a replaced workspace after late native completion", async () => {
    const f = fixture();
    await f.controller.selectWorkspace("/old");
    const creating = deferred<unknown>();
    let started!: () => void;
    const createStarted = new Promise<void>((resolve) => { started = resolve; });
    const normalSend = f.send.getMockImplementation()!;
    f.send.mockImplementation(async (command, args) => {
      if (command === "create_project_entry") { started(); return creating.promise; }
      return normalSend(command, args);
    });
    const pending = f.controller.initialize();
    await createStarted;
    await f.controller.selectWorkspace("/new");
    creating.resolve({ name: "wiki", path: "wiki", kind: "directory" });
    expect(await pending).toBeUndefined();
    expect(f.send.mock.calls.filter(([command]) => command === "create_project_entry")).toHaveLength(1);
    expect(f.controller.state).toMatchObject({ creating: false, exists: false, indexExists: false });
    f.controller.dispose();
  });
});
