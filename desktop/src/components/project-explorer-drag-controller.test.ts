import { afterEach, describe, expect, it, vi } from "vitest";
import { createProjectExplorerDragController } from "./project-explorer-drag-controller.svelte";
import { PROJECT_TREE_DROP_EVENT, PROJECT_TREE_DROP_TARGET_SELECTOR, type ProjectTreeEntry } from "../lib/project-tree";

const folder: ProjectTreeEntry = { path: "folder", name: "folder", kind: "directory" };
const file: ProjectTreeEntry = { path: "other", name: "other", kind: "file" };

function fixture(native?: (entries: ProjectTreeEntry[]) => Promise<void>) {
  vi.useFakeTimers();
  const root = { dataset: {} as Record<string, string>, style: { userSelect: "text", cursor: "default" } };
  const row = { dataset: { projectMoveTarget: "target" } as Record<string, string> };
  const composer = { dispatchEvent: vi.fn() };
  let hit: "folder" | "file" | "gutter" | "background" | "composer" = "folder";
  const element = { closest: vi.fn((selector: string) => {
    if (selector === PROJECT_TREE_DROP_TARGET_SELECTOR) return hit === "composer" ? composer : null;
    if (selector === "[data-project-move-row]") return hit === "gutter" ? row : null;
    if (selector === "[data-project-tree-path]") return hit === "folder" || hit === "file" ? row : null;
    if (selector === "[data-project-move-target]") return hit === "background" ? { dataset: { projectMoveTarget: "" } } : null;
    return null;
  }) };
  vi.stubGlobal("document", { documentElement: root, elementFromPoint: () => element });
  const source = { setPointerCapture: vi.fn(), hasPointerCapture: () => true, releasePointerCapture: vi.fn() };
  const event = (x = 0, pointerId = 1) => ({ button: 0, pointerId, clientX: x, clientY: 0, currentTarget: source, preventDefault: vi.fn() } as unknown as PointerEvent);
  const move = vi.fn();
  const entries = vi.fn(() => [folder, file]);
  const controller = createProjectExplorerDragController({ entries, move, native });
  return { controller, move, entries, event, root, source, row, composer, hit: (value: typeof hit) => { hit = value; if (value === "file") delete row.dataset.projectMoveTarget; } };
}
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("Files group drag", () => {
  it("hands the selected group to AppKit once past the threshold and suppresses click until completion", async () => {
    let done!: () => void;
    const native = vi.fn(() => new Promise<void>((resolve) => { done = resolve; }));
    const f = fixture(native);
    f.controller.start(f.event(), folder); f.controller.move(f.event(2));
    expect(native).not.toHaveBeenCalled();
    f.controller.move(f.event(8)); f.controller.move(f.event(10)); f.controller.finish(f.event(10));
    expect(native).toHaveBeenCalledExactlyOnceWith([folder, file], expect.any(AbortSignal));
    expect(f.move).not.toHaveBeenCalled();
    expect(f.controller.suppressEntryClick).toBe(true);
    expect(f.source.releasePointerCapture).toHaveBeenCalledWith(1);
    expect(f.root.style).toEqual({ userSelect: "text", cursor: "default" });
    done(); await Promise.resolve();
    vi.runAllTimers();
    expect(f.controller.suppressEntryClick).toBe(false);
    f.controller.dispose();
  });
  it("does not schedule suppression timers after a native drag completes on a disposed panel", async () => {
    let done!: () => void;
    const f = fixture(() => new Promise<void>((resolve) => { done = resolve; }));
    f.controller.start(f.event(), folder); f.controller.move(f.event(8));
    f.controller.dispose(); done(); await Promise.resolve();
    expect(vi.getTimerCount()).toBe(0);
    expect(f.controller.suppressEntryClick).toBe(false);
  });
  it("resolves nested row indentation and right gutters to that row, never root", () => {
    const f = fixture();
    f.entries.mockReturnValue([{ ...file, path: "nested/file" }]);
    f.hit("gutter");
    f.controller.start(f.event(), file); f.controller.move(f.event(8));
    expect(f.controller.destination).toBe("target");
    f.controller.finish(f.event(8));
    expect(f.move).toHaveBeenCalledWith([{ ...file, path: "nested/file" }], "target");
    f.controller.dispose();
  });
  it("takes selection only past the threshold, moves the group, suppresses click and releases resources", () => {
    const f = fixture();
    f.controller.start(f.event(), folder);
    f.controller.move(f.event(2));
    expect(f.entries).not.toHaveBeenCalled();
    f.controller.move(f.event(8));
    expect(f.controller.count).toBe(2);
    expect(f.controller.destination).toBe("target");
    f.controller.finish(f.event(8));
    expect(f.move).toHaveBeenCalledWith([folder, file], "target");
    expect(f.controller.suppressEntryClick).toBe(true);
    expect(f.source.releasePointerCapture).toHaveBeenCalledWith(1);
    expect(f.root.style).toEqual({ userSelect: "text", cursor: "default" });
    f.controller.dispose();
    expect(vi.getTimerCount()).toBe(0);
    expect(f.controller.suppressEntryClick).toBe(false);
  });
  it("rejects self/descendant/file targets and allows root background", () => {
    const f = fixture();
    f.controller.start(f.event(), folder);
    f.row.dataset.projectMoveTarget = "folder/child";
    f.controller.move(f.event(8));
    expect(f.controller.destination).toBeNull();
    f.controller.finish(f.event(8));
    expect(f.move).not.toHaveBeenCalled();
    f.controller.start(f.event(), folder); f.hit("file"); f.controller.move(f.event(8));
    expect(f.controller.destination).toBeNull();
    f.controller.cancel(f.event(8));
    f.controller.start(f.event(), folder); f.hit("background");
    // These are already in root, so this is intentionally a no-op.
    f.controller.move(f.event(8));
    expect(f.controller.destination).toBeNull();
    f.controller.clear();
    f.entries.mockReturnValue([{ ...file, path: "nested/file" }]);
    f.controller.start(f.event(), file); f.controller.move(f.event(8));
    expect(f.controller.destination).toBe("");
    f.controller.finish(f.event(8));
    expect(f.move).toHaveBeenLastCalledWith([{ ...file, path: "nested/file" }], "");
    f.controller.dispose();
  });
  it("keeps composer path drops for each selected entry and cancellation publishes no drop", () => {
    const f = fixture();
    f.hit("composer"); f.controller.start(f.event(), folder); f.controller.move(f.event(8));
    f.controller.cancel(f.event(8));
    expect(f.composer.dispatchEvent.mock.calls.filter(([event]) => event.type === PROJECT_TREE_DROP_EVENT)).toHaveLength(0);
    f.controller.start(f.event(), folder); f.controller.move(f.event(8)); f.controller.finish(f.event(8));
    const drops = f.composer.dispatchEvent.mock.calls.filter(([event]) => event.type === PROJECT_TREE_DROP_EVENT);
    expect(drops.map(([event]) => event.detail.path)).toEqual(["folder", "other"]);
    f.controller.dispose();
  });
});
