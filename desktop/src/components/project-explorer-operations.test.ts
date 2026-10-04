import { describe, expect, it } from "vitest";
import { createProjectExplorerOperations, type ProjectOperationClaim } from "./project-explorer-operations.svelte";

const tree = (path: string): ProjectOperationClaim => ({ path, kind: "tree" });
const directory = (path: string): ProjectOperationClaim => ({ path, kind: "directory" });

describe("Project Explorer concurrent operations", () => {
  it("permits unrelated mutations and clipboard commands throughout a pending deletion", async () => {
    const operations = createProjectExplorerOperations();
    const deletion = operations.begin("Delete big", [tree("big")])!;
    let resolveDelete!: () => void;
    const pending = new Promise<void>((resolve) => { resolveDelete = resolve; });
    const completion = pending.then(() => operations.finish(deletion));

    const creation = operations.begin("Create sibling", [directory(""), tree("new.txt")])!;
    const clipboard = operations.begin("Copy path", [])!;
    expect(operations.active).toHaveLength(3);
    expect(operations.begin("Delete inside big", [tree("big/child")])).toBeNull();
    expect(operations.begin("Rename big", [tree("big")])).toBeNull();
    expect(operations.begin("Create inside big", [directory("big"), tree("big/new.txt")])).toBeNull();
    operations.finish(creation);
    operations.finish(clipboard);
    expect(operations.isCurrent(deletion)).toBe(true);
    resolveDelete();
    await completion;
    expect(operations.active).toHaveLength(0);
  });

  it("guards ancestors, destinations and path boundaries in either acquisition order", () => {
    const operations = createProjectExplorerOperations();
    const creation = operations.begin("Create", [directory("parent"), tree("parent/new.txt")])!;
    expect(operations.canStart([tree("parent")])).toBe(false);
    expect(operations.canStart([tree("")])).toBe(false);
    expect(operations.canStart([tree("parent/other.txt")])).toBe(true);
    expect(operations.canStart([tree("parent-extra")])).toBe(true);
    expect(operations.canStart([directory("parent"), tree("parent/new.txt")])).toBe(false);
    operations.finish(creation);
    const removal = operations.begin("Delete parent", [tree("parent")])!;
    expect(operations.canStart([directory("parent/subfolder")])).toBe(false);
    expect(operations.canStart([directory("")])).toBe(true);
    operations.finish(removal);
  });

  it("protects partially copied output while allowing other destination branches", () => {
    const operations = createProjectExplorerOperations();
    operations.begin("Copy", [tree("source"), tree("output")]);
    expect(operations.canStart([tree("source/child")])).toBe(false);
    expect(operations.canStart([tree("output/newly-visible")])).toBe(false);
    expect(operations.canStart([directory("output")])).toBe(false);
    expect(operations.canStart([tree("other")])).toBe(true);
  });

  it("keeps independent out-of-order completions current and releases only the owning token", () => {
    const operations = createProjectExplorerOperations();
    const slow = operations.begin("Slow", [tree("slow")])!;
    const fast = operations.begin("Fast", [tree("fast")])!;
    expect(operations.finish(fast)).toBe(true);
    expect(operations.isCurrent(slow)).toBe(true);
    expect(operations.finish(fast)).toBe(false);
    expect(operations.active).toEqual([slow]);
    expect(operations.finish(slow)).toBe(true);
  });

  it("invalidates old workspace/teardown completions even when returning to the same path", () => {
    const operations = createProjectExplorerOperations();
    const old = operations.begin("Old workspace", [tree("same")])!;
    operations.invalidate();
    const current = operations.begin("New workspace", [tree("same")])!;
    expect(operations.isCurrent(old)).toBe(false);
    expect(operations.finish(old)).toBe(false);
    expect(operations.active).toEqual([current]);
    operations.invalidate();
    expect(operations.finish(current)).toBe(false);
    expect(operations.active).toHaveLength(0);
  });
});
