import { describe, expect, it, vi } from "vitest";
import { createProjectRelocation } from "./project-relocation";
import { PROJECT_IDENTITIES_STORAGE_KEY } from "../lib/project-identity";

function setup(options: {
  directories: string[];
  ids?: Record<string, string>;
  recorded?: Record<string, string>;
  confirm?: boolean[];
  picked?: string | null;
  recent?: string[];
}) {
  const values = new Map<string, string>();
  if (options.recorded) values.set(PROJECT_IDENTITIES_STORAGE_KEY, JSON.stringify(options.recorded));
  const storage = {
    get length() { return values.size; },
    key: (index: number) => [...values.keys()][index] ?? null,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  };
  const answers = [...(options.confirm ?? [])];
  const invoke = vi.fn(async (command: string, args: Record<string, unknown>) => {
    if (command === "local_path_kind") return options.directories.includes(args.path as string) ? "directory" : null;
    if (command === "project_identity") return options.ids?.[args.workspace as string] ?? null;
    if (command === "relocate_project_state") return { movedSessions: 2, conflicts: [], skipped: [], tabSnapshotMoved: true };
    throw new Error(`unexpected ${command}`);
  });
  const deps = {
    invoke: invoke as never,
    confirm: vi.fn(async () => answers.shift() ?? false),
    pickFolder: vi.fn(async () => options.picked ?? null),
    storage: () => storage,
    relocateInMemory: vi.fn(),
    reportWarning: vi.fn(),
    recentProjects: () => options.recent ?? [],
  };
  return { relocation: createProjectRelocation(deps), deps, invoke, values };
}

describe("project relocation planning", () => {
  it("opens an existing folder unchanged when its identity is unknown or current", async () => {
    const { relocation } = setup({ directories: ["/p"], ids: { "/p": "id" }, recorded: { id: "/p" } });
    await expect(relocation.plan("/p")).resolves.toEqual({ target: "/p" });
  });

  it("offers to locate a missing folder and relocates to the picked folder", async () => {
    const { relocation, deps } = setup({
      directories: ["/new"], ids: { "/new": "id" }, recorded: { id: "/old" }, confirm: [true], picked: "/new",
    });
    await expect(relocation.plan("/old")).resolves.toEqual({ target: "/new", relocateFrom: "/old" });
    expect(deps.pickFolder).toHaveBeenCalledWith("/old");
  });

  it("cancels when locating is declined or the picked project differs and is not confirmed", async () => {
    expect(await setup({ directories: [], confirm: [false] }).relocation.plan("/old")).toBeNull();
    const mismatch = setup({
      directories: ["/other"], ids: { "/other": "id2" }, recorded: { id1: "/old" }, confirm: [true, false], picked: "/other",
    });
    expect(await mismatch.relocation.plan("/old")).toBeNull();
  });

  it("detects a renamed folder by its stable ID when the previous path is gone", async () => {
    const accepted = setup({ directories: ["/new"], ids: { "/new": "id" }, recorded: { id: "/old" }, confirm: [true] });
    await expect(accepted.relocation.plan("/new")).resolves.toEqual({ target: "/new", relocateFrom: "/old" });
    const declined = setup({ directories: ["/new"], ids: { "/new": "id" }, recorded: { id: "/old" }, confirm: [false] });
    await expect(declined.relocation.plan("/new")).resolves.toEqual({ target: "/new" });
    // A copy whose original still exists is not a move.
    const copied = setup({ directories: ["/new", "/old"], ids: { "/new": "id" }, recorded: { id: "/old" } });
    await expect(copied.relocation.plan("/new")).resolves.toEqual({ target: "/new" });
    expect(copied.deps.confirm).not.toHaveBeenCalled();
    await copied.relocation.record("/new");
    expect(JSON.parse(copied.values.get(PROJECT_IDENTITIES_STORAGE_KEY)!)).toEqual({ id: "/old" });
  });

  it("offers a same-name missing recent project when there is no recorded ID, and remembers a decline", async () => {
    const accepted = setup({ directories: ["/x/app"], recent: ["/y/app", "/z/other"], confirm: [true] });
    await expect(accepted.relocation.plan("/x/app")).resolves.toEqual({ target: "/x/app", relocateFrom: "/y/app" });
    const declined = setup({ directories: ["/x/app"], recent: ["/y/app"], confirm: [false] });
    await expect(declined.relocation.plan("/x/app")).resolves.toEqual({ target: "/x/app" });
    await expect(declined.relocation.plan("/x/app")).resolves.toEqual({ target: "/x/app" });
    expect(declined.deps.confirm).toHaveBeenCalledTimes(1);
  });

  it("does not guess between several or existing or differently identified same-name projects", async () => {
    const many = setup({ directories: ["/x/app"], recent: ["/y/app", "/w/app"] });
    await expect(many.relocation.plan("/x/app")).resolves.toEqual({ target: "/x/app" });
    const existing = setup({ directories: ["/x/app", "/y/app"], recent: ["/y/app"] });
    await expect(existing.relocation.plan("/x/app")).resolves.toEqual({ target: "/x/app" });
    const other = setup({ directories: ["/x/app"], ids: { "/x/app": "id1" }, recorded: { id2: "/y/app" }, recent: ["/y/app"] });
    await expect(other.relocation.plan("/x/app")).resolves.toEqual({ target: "/x/app" });
    for (const s of [many, existing, other]) expect(s.deps.confirm).not.toHaveBeenCalled();
  });

  it("relocates native state, then Desktop storage and in-memory state, and records identity", async () => {
    const { relocation, deps, invoke, values } = setup({ directories: ["/new"], ids: { "/new": "id" }, recorded: { id: "/old" } });
    await relocation.relocate("/old", "/new");
    expect(invoke).toHaveBeenCalledWith("relocate_project_state", { from: "/old", to: "/new" });
    expect(JSON.parse(values.get(PROJECT_IDENTITIES_STORAGE_KEY)!)).toEqual({ id: "/new" });
    expect(deps.relocateInMemory).toHaveBeenCalledWith("/old", "/new");
    await relocation.record("/new");
    expect(JSON.parse(values.get(PROJECT_IDENTITIES_STORAGE_KEY)!)).toEqual({ id: "/new" });
  });
});
