import { describe, expect, it, vi } from "vitest";
import { installProjectExplorerNativeDrop } from "./project-explorer-native-drop";
import { PROJECT_FILE_DROP_EVENT, type ProjectEntryDrag } from "../lib/desktop-file-drop";
import type { ProjectEntryClipboard } from "../lib/project-entry-clipboard";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
const copied: ProjectEntryClipboard = { workspace: "/", path: "source/a", kind: "file", entries: [{ path: "source/a", kind: "file" }, { path: "project/target/b", kind: "directory" }] };
const settle = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };

function fixture() {
  const panel = new EventTarget();
  let generation = 0;
  const options = { workspace: () => "/project", generation: () => generation, hover: vi.fn(), mutate: vi.fn(async () => {}), report: vi.fn(), error: vi.fn() };
  const dispose = installProjectExplorerNativeDrop(panel as HTMLElement, options);
  return { options, dispose, invalidate: () => { generation++; }, drop: (reference: Promise<ProjectEntryDrag> = Promise.resolve({ reference: copied }), operation = "copy") => panel.dispatchEvent(new CustomEvent(PROJECT_FILE_DROP_EVENT, { detail: { reference, destination: "target", operation } })) };
}

describe("Files native drop adapter", () => {
  it("uses history for copies and cross-workspace moves, filtering move no-ops only", async () => {
    const f = fixture();
    f.drop(); await settle();
    expect(f.options.mutate).toHaveBeenCalledWith({ type: "copy", paths: ["source/a", "project/target/b"], destination: "target", sourceWorkspace: "/" }, "Copy from Finder");
    f.drop(Promise.resolve({ reference: copied }), "move"); await settle();
    expect(f.options.mutate).toHaveBeenLastCalledWith({ type: "importMove", paths: ["source/a"], destination: "target", sourceWorkspace: "/" }, "Move from Finder");
    f.dispose();
  });
  it("ignores stale completions after workspace invalidation or panel teardown", async () => {
    const f = fixture();
    f.drop(); f.invalidate(); await settle();
    f.drop(); f.dispose(); await settle();
    expect(f.options.mutate).not.toHaveBeenCalled();
  });
  it("keeps same-window Files drops as moves after native source completion", async () => {
    const f = fixture();
    f.drop(Promise.resolve({ reference: copied, source: { workspace: "/project", paths: ["a"] } })); await settle();
    expect(f.options.mutate).toHaveBeenCalledWith({ type: "importMove", paths: ["source/a"], destination: "target", sourceWorkspace: "/" }, "Move from Finder");
    f.dispose();
  });
  it("reports native errors and removes drop listeners", async () => {
    const f = fixture();
    f.drop(Promise.reject(new Error("missing source"))); await settle();
    expect(f.options.error).toHaveBeenCalledWith("missing source");
    expect(f.options.report).toHaveBeenCalledTimes(1);
    f.dispose(); f.drop(); await settle();
    expect(f.options.mutate).not.toHaveBeenCalled();
  });
});
