import { describe, expect, it } from "vitest";
import {
  parseProjectIdentities,
  PROJECT_IDENTITIES_STORAGE_KEY,
  projectIdentityForPath,
  recordProjectIdentity,
  relocateDesktopStorage,
} from "./project-identity";
import { RECENT_PROJECTS_STORAGE_KEY, WORKSPACE_STORAGE_KEY } from "./recent-projects";

function memoryStorage(initial: Record<string, string>) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    get length() { return values.size; },
    key: (index: number) => [...values.keys()][index] ?? null,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  };
}

describe("project identities", () => {
  it("parses defensively and keeps one ID per path", () => {
    expect(parseProjectIdentities("[1]").size).toBe(0);
    expect(parseProjectIdentities("{bad").size).toBe(0);
    const parsed = parseProjectIdentities(JSON.stringify({ a: "/one", b: 3 }));
    expect([...parsed]).toEqual([["a", "/one"]]);
    const next = recordProjectIdentity(parsed, "c", "/one");
    expect([...next]).toEqual([["c", "/one"]]);
    expect(projectIdentityForPath(next, "/one")).toBe("c");
    expect(projectIdentityForPath(next, "/two")).toBeUndefined();
  });
});

describe("relocateDesktopStorage", () => {
  it("moves path-keyed Desktop state without overwriting the target", () => {
    const from = "/projects/old";
    const to = "/projects/new";
    const storage = memoryStorage({
      [RECENT_PROJECTS_STORAGE_KEY]: JSON.stringify(["/a", from, "/b"]),
      [WORKSPACE_STORAGE_KEY]: from,
      [PROJECT_IDENTITIES_STORAGE_KEY]: JSON.stringify({ id1: from }),
      [`pix.desktop.modelSelectionFrequency.${encodeURIComponent(from)}`]: "{\"m\":2}",
      "pix.desktop.windowLayout.main.sessionTabs": JSON.stringify({ [from]: ["s1"], "/a": ["s2"] }),
      "pix.desktop.windowLayout.main.activeSessions": JSON.stringify({ [from]: "s1", [to]: "keep" }),
      "pix.desktop.windowLayout.main.sessionTabModels": "not json",
      "pix.desktop.unrelated": JSON.stringify({ [from]: 1 }),
    });

    relocateDesktopStorage(storage, from, to);

    expect(JSON.parse(storage.getItem(RECENT_PROJECTS_STORAGE_KEY)!)).toEqual(["/a", to, "/b"]);
    expect(storage.getItem(WORKSPACE_STORAGE_KEY)).toBe(to);
    expect(JSON.parse(storage.getItem(PROJECT_IDENTITIES_STORAGE_KEY)!)).toEqual({ id1: to });
    expect(storage.getItem(`pix.desktop.modelSelectionFrequency.${encodeURIComponent(from)}`)).toBeNull();
    expect(storage.getItem(`pix.desktop.modelSelectionFrequency.${encodeURIComponent(to)}`)).toBe("{\"m\":2}");
    expect(JSON.parse(storage.getItem("pix.desktop.windowLayout.main.sessionTabs")!))
      .toEqual({ "/a": ["s2"], [to]: ["s1"] });
    expect(JSON.parse(storage.getItem("pix.desktop.windowLayout.main.activeSessions")!))
      .toEqual({ [to]: "s1" });
    expect(storage.getItem("pix.desktop.windowLayout.main.sessionTabModels")).toBe("not json");
    expect(JSON.parse(storage.getItem("pix.desktop.unrelated")!)).toEqual({ [from]: 1 });
  });

  it("deduplicates recents when the target is already listed", () => {
    const storage = memoryStorage({
      [RECENT_PROJECTS_STORAGE_KEY]: JSON.stringify(["/new", "/old"]),
    });
    relocateDesktopStorage(storage, "/old", "/new");
    expect(JSON.parse(storage.getItem(RECENT_PROJECTS_STORAGE_KEY)!)).toEqual(["/new"]);
  });
});
