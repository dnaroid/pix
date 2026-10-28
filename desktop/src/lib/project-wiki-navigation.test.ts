import { describe, expect, it, vi } from "vitest";
import type { ProjectWikiConfig } from "./project-wiki";
import { createProjectWikiNavigation, wikiFolderIndexCandidates, wikiIndexOwner } from "./project-wiki-navigation";

function config(path = "wiki", index = "index.md"): ProjectWikiConfig {
  return { path, index, indexPath: `${path}/${index}` };
}

function pending() {
  let resolve!: (exists: boolean) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<boolean>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function harness(initial = config()) {
  let workspace = "/project";
  let settings = initial;
  const exists = vi.fn(async (_workspace: string, _path: string) => false);
  const opened = vi.fn<(path: string) => void>();
  const missing = vi.fn<(directory: string) => void>();
  const error = vi.fn<(error: unknown) => void>();
  const navigation = createProjectWikiNavigation({
    workspace: () => workspace, config: () => settings, exists,
    onOpenFile: opened, onMissingIndex: missing, onError: error,
  });
  return {
    navigation, exists, opened, missing, error,
    setWorkspace(next: string) { workspace = next; },
    setConfig(next: ProjectWikiConfig) { settings = next; },
  };
}

describe("Wiki folder indexes", () => {
  it("uses only the configured root index, including a nested home page", () => {
    expect(wikiFolderIndexCandidates("", config())).toEqual(["index.md"]);
    expect(wikiFolderIndexCandidates("", config("docs/game", "overview/home.md"))).toEqual(["overview/home.md"]);
  });

  it("prefers a folder's configured index and then its conventional indexes", () => {
    const custom = config("docs/game", "rules/home.md");
    expect(wikiFolderIndexCandidates("rules", custom)).toEqual(["rules/home.md", "rules/index.md", "rules/index.markdown"]);
    expect(wikiFolderIndexCandidates("rules/effects", custom)).toEqual(["rules/effects/index.md", "rules/effects/index.markdown"]);
  });

  it("deduplicates configured conventional indexes without changing precedence", () => {
    expect(wikiFolderIndexCandidates("rules", config("wiki", "rules/index.md")))
      .toEqual(["rules/index.md", "rules/index.markdown"]);
    expect(wikiFolderIndexCandidates("rules", config("wiki", "rules/index.markdown")))
      .toEqual(["rules/index.markdown", "rules/index.md"]);
  });

  it("maps hidden index files to their folders while retaining ordinary pages", () => {
    expect(wikiIndexOwner("index.md", config())).toBe("");
    expect(wikiIndexOwner("index.markdown", config())).toBeNull();
    const custom = config("docs/game", "overview/home.md");
    expect(wikiIndexOwner("overview/home.md", custom)).toBe("overview");
    expect(wikiIndexOwner("index.md", custom)).toBeNull();
    expect(wikiIndexOwner("rules/index.md", custom)).toBe("rules");
    expect(wikiIndexOwner("rules/effects/INDEX.MARKDOWN", custom)).toBe("rules/effects");
    expect(wikiIndexOwner("rules/combat.md", custom)).toBeNull();
    expect(wikiIndexOwner("overview/index-notes.md", custom)).toBeNull();
  });
});

describe("Wiki index navigation", () => {
  it("opens the configured index using a full project-relative path", async () => {
    const h = harness(config("docs/game", "overview/home.md"));
    h.exists.mockResolvedValue(true);
    await h.navigation.openDirectory("");
    expect(h.exists).toHaveBeenCalledExactlyOnceWith("/project", "docs/game/overview/home.md");
    expect(h.opened).toHaveBeenCalledExactlyOnceWith("docs/game/overview/home.md");
    expect(h.missing).not.toHaveBeenCalled();
  });

  it("tries nested candidates sequentially and stops at the first existing file", async () => {
    const h = harness(config("docs/game", "rules/home.md"));
    const first = pending();
    h.exists.mockReturnValueOnce(first.promise).mockResolvedValueOnce(true);
    const request = h.navigation.openDirectory("rules");
    expect(h.exists.mock.calls).toEqual([["/project", "docs/game/rules/home.md"]]);
    first.resolve(false);
    await request;
    expect(h.exists.mock.calls).toEqual([
      ["/project", "docs/game/rules/home.md"], ["/project", "docs/game/rules/index.md"],
    ]);
    expect(h.opened).toHaveBeenCalledExactlyOnceWith("docs/game/rules/index.md");
  });

  it("falls back to index.markdown and reports a missing index without opening a file", async () => {
    const h = harness();
    h.exists.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    await h.navigation.openDirectory("rules");
    expect(h.opened).toHaveBeenCalledExactlyOnceWith("wiki/rules/index.markdown");
    h.opened.mockClear();
    await h.navigation.openDirectory("empty");
    expect(h.opened).not.toHaveBeenCalled();
    expect(h.missing).toHaveBeenCalledExactlyOnceWith("empty");
  });

  it("does not fall back to an unconfigured root index", async () => {
    const h = harness(config("docs/game", "home.md"));
    await h.navigation.openDirectory("");
    expect(h.exists).toHaveBeenCalledExactlyOnceWith("/project", "docs/game/home.md");
    expect(h.missing).toHaveBeenCalledExactlyOnceWith("");
    expect(h.opened).not.toHaveBeenCalled();
  });

  it("a newer file selection cancels pending folder navigation and fallback", async () => {
    const h = harness();
    const lookup = pending();
    h.exists.mockReturnValueOnce(lookup.promise);
    const request = h.navigation.openDirectory("rules");
    h.navigation.openFile("characters/rogue.md");
    lookup.resolve(false);
    await request;
    expect(h.opened).toHaveBeenCalledExactlyOnceWith("wiki/characters/rogue.md");
    expect(h.exists).toHaveBeenCalledTimes(1);
    expect(h.missing).not.toHaveBeenCalled();
  });

  it("a newer folder selection wins over an older successful lookup", async () => {
    const h = harness();
    const older = pending();
    h.exists.mockReturnValueOnce(older.promise).mockResolvedValueOnce(true);
    const first = h.navigation.openDirectory("rules");
    await h.navigation.openDirectory("characters");
    older.resolve(true);
    await first;
    expect(h.opened).toHaveBeenCalledExactlyOnceWith("wiki/characters/index.md");
  });

  it("rechecks ownership after the fallback await too", async () => {
    const h = harness();
    const fallback = pending();
    h.exists.mockResolvedValueOnce(false).mockReturnValueOnce(fallback.promise);
    const request = h.navigation.openDirectory("rules");
    await Promise.resolve();
    expect(h.exists).toHaveBeenCalledTimes(2);
    h.navigation.openFile("combat.md");
    fallback.resolve(true);
    await request;
    expect(h.opened).toHaveBeenCalledExactlyOnceWith("wiki/combat.md");
  });

  it.each(["workspace", "path", "index", "dispose"] as const)
    ("invalidates pending requests when %s changes", async (change) => {
      const h = harness();
      const lookup = pending();
      h.exists.mockReturnValueOnce(lookup.promise);
      const request = h.navigation.openDirectory("rules");
      if (change === "workspace") h.setWorkspace("/other-project");
      if (change === "path") h.setConfig(config("docs/game"));
      if (change === "index") h.setConfig(config("wiki", "home.md"));
      if (change === "dispose") h.navigation.dispose();
      lookup.resolve(true);
      await request;
      expect(h.opened).not.toHaveBeenCalled();
      expect(h.missing).not.toHaveBeenCalled();
      expect(h.error).not.toHaveBeenCalled();
    });

  it("reports current lookup errors but suppresses errors from superseded requests", async () => {
    const h = harness();
    const failure = new Error("Cannot read the folder index");
    h.exists.mockRejectedValueOnce(failure);
    await h.navigation.openDirectory("rules");
    expect(h.error).toHaveBeenCalledExactlyOnceWith(failure);
    h.error.mockClear();
    const stale = pending();
    h.exists.mockReturnValueOnce(stale.promise);
    const request = h.navigation.openDirectory("rules");
    h.navigation.openFile("combat.md");
    stale.reject(failure);
    await request;
    expect(h.error).not.toHaveBeenCalled();
    expect(h.missing).not.toHaveBeenCalled();
  });

  it("does not start new navigation after disposal", async () => {
    const h = harness();
    h.navigation.dispose();
    h.navigation.openFile("combat.md");
    await h.navigation.openDirectory("rules");
    expect(h.exists).not.toHaveBeenCalled();
    expect(h.opened).not.toHaveBeenCalled();
    expect(h.missing).not.toHaveBeenCalled();
  });

  it("can cancel a lookup for name editing without disabling future navigation", async () => {
    const h = harness();
    const lookup = pending();
    h.exists.mockReturnValueOnce(lookup.promise);
    const request = h.navigation.openDirectory("rules");
    h.navigation.cancel();
    lookup.resolve(true);
    await request;
    expect(h.opened).not.toHaveBeenCalled();
    expect(h.missing).not.toHaveBeenCalled();
    h.navigation.openFile("combat.md");
    expect(h.opened).toHaveBeenCalledExactlyOnceWith("wiki/combat.md");
  });
});
