import { describe, expect, it, vi } from "vitest";
import { createPreviewMarkdownController } from "./preview-markdown-controller.svelte";

function fixture(preferDocumentRelative = true) {
  let previewId = 1;
  let file = { path: "wiki/rules/combat.md", content: "" };
  const validate = vi.fn(async (_path: string): Promise<boolean | "directory"> => true);
  const open = vi.fn();
  const controller = createPreviewMarkdownController({
    previewId: () => previewId, file: () => file,
    preferDocumentRelative: () => preferDocumentRelative,
    onValidateProjectFile: () => validate, onOpenProjectFile: () => open,
    onOpenLocalFile: () => undefined, rememberScroll: () => {},
  });
  return { controller, validate, open, replace() { previewId++; file = { path: "wiki/index.md", content: "" }; } };
}

describe("Wiki Preview links", () => {
  it("resolves sibling and parent paths against the document, without a root-name collision", async () => {
    const f = fixture();
    await f.controller.openProject("index.md");
    expect(f.validate).toHaveBeenCalledExactlyOnceWith("wiki/rules/index.md");
    expect(f.open).toHaveBeenCalledWith("wiki/rules/index.md", undefined);
    expect(f.controller.projectLinkPath("../images/50%#hero.png")).toBe("wiki/images/50%#hero.png");
  });
  it("retains root-first agent file references for ordinary Preview", async () => {
    const f = fixture(false);
    await f.controller.openProject("src/main.ts");
    expect(f.validate).toHaveBeenCalledExactlyOnceWith("src/main.ts");
  });
  it("does not navigate or cache an old validation after replacing the document", async () => {
    const f = fixture();
    let complete!: (value: boolean) => void;
    f.validate.mockReturnValueOnce(new Promise<boolean>((resolve) => { complete = resolve; }));
    const pending = f.controller.openProject("next.md");
    f.replace();
    complete(true);
    await pending;
    expect(f.open).not.toHaveBeenCalled();
    await f.controller.openProject("next.md");
    expect(f.open).toHaveBeenCalledWith("wiki/next.md", undefined);
  });
});
