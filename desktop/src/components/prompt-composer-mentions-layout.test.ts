import { parse } from "svelte/compiler";
import { describe, expect, it } from "vitest";
import source from "./PromptComposer.svelte?raw";

type TemplateNode = {
  type: string;
  name?: string;
  children?: TemplateNode[];
  attributes?: { name?: string }[];
};

describe("composer mention popup layout", () => {
  it("anchors the popup outside the clipping form, next to the form", () => {
    const ast = parse(source);
    let popupAncestors: TemplateNode[] | undefined;
    function visit(node: TemplateNode, ancestors: TemplateNode[]): void {
      if (node.name === "PromptComposerMentions") popupAncestors = ancestors;
      for (const child of node.children ?? []) visit(child, [...ancestors, node]);
    }
    visit(ast.html as TemplateNode, []);
    expect(popupAncestors).toBeDefined();
    expect(popupAncestors?.some((node) => node.name === "form")).toBe(false);
    const anchor = popupAncestors?.at(-1);
    expect(anchor?.attributes?.some((attribute) => attribute.name === "data-file-mention-anchor")).toBe(true);
    expect(anchor?.children?.some((node) => node.name === "form")).toBe(true);
  });
});
