import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolvePreviewWikiDirectory } from "./preview-wiki-directory";

const backend = vi.hoisted(() => ({ invoke: vi.fn(), config: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: backend.invoke }));
vi.mock("./workspace-config-persistence", () => ({ readWorkspaceConfig: backend.config }));

beforeEach(() => { backend.invoke.mockReset(); backend.config.mockReset(); });

describe("Wiki directory Preview resolution", () => {
  it.each(["wiki", "wiki/rules"])("generates %s without any write commands", async (path) => {
    backend.invoke.mockImplementation(async (command: string) => command === "list_project_directory"
      ? [{ name: "combat.md", path: `${path}/combat.md`, kind: "file" }] : false);
    const target = await resolvePreviewWikiDirectory("/project", path, () => true);
    expect(target).toMatchObject({ kind: "contents", file: { virtualWikiDirectory: path } });
    expect(backend.invoke.mock.calls.map(([command]) => command)).toEqual(
      path === "wiki" ? ["project_file_exists", "list_project_directory"]
        : ["project_file_exists", "project_file_exists", "list_project_directory"],
    );
  });

  it("prefers a real custom index and never lists children for it", async () => {
    backend.config.mockResolvedValue({ content: '{"wiki":{"path":"docs/game","index":"overview/home.md"}}' });
    backend.invoke.mockResolvedValue(true);
    expect(await resolvePreviewWikiDirectory("/project", "docs/game", () => true))
      .toEqual({ kind: "index", path: "docs/game/overview/home.md" });
    expect(backend.invoke).toHaveBeenCalledExactlyOnceWith("project_file_exists", { workspace: "/project", path: "docs/game/overview/home.md" });
  });

  it("rechecks disk on reopening so a newly added real index supersedes contents", async () => {
    backend.invoke.mockImplementation(async (command: string) => command === "list_project_directory" ? [] : false);
    expect(await resolvePreviewWikiDirectory("/project", "wiki/rules", () => true)).toMatchObject({ kind: "contents" });
    backend.invoke.mockReset().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    expect(await resolvePreviewWikiDirectory("/project", "wiki/rules", () => true))
      .toEqual({ kind: "index", path: "wiki/rules/index.markdown" });
  });

  it("does not treat prefix siblings or project directories as Wiki", async () => {
    for (const path of ["wiki-other", "src", "wiki2/rules"]) {
      expect(await resolvePreviewWikiDirectory("/project", path, () => true)).toBeUndefined();
    }
    expect(backend.invoke).not.toHaveBeenCalled();
  });

  it.each(["config", "index", "listing"])("rejects stale %s replies", async (stage) => {
    let current = true;
    backend.config.mockImplementation(async () => {
      if (stage === "config") current = false;
      return undefined;
    });
    backend.invoke.mockImplementation(async (command: string) => {
      if (stage === "index" && command === "project_file_exists") current = false;
      if (stage === "listing" && command === "list_project_directory") current = false;
      return command === "list_project_directory" ? [] : false;
    });
    expect(await resolvePreviewWikiDirectory("/project", "wiki", () => current)).toBeUndefined();
    if (stage === "config") expect(backend.invoke).not.toHaveBeenCalled();
  });

  it("propagates listing errors rather than displaying false empty contents", async () => {
    backend.invoke.mockImplementation(async (command: string) => {
      if (command === "list_project_directory") throw new Error("Folder unavailable");
      return false;
    });
    await expect(resolvePreviewWikiDirectory("/project", "wiki", () => true)).rejects.toThrow("Folder unavailable");
  });
});
