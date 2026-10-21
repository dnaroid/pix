import { afterEach, describe, expect, it, vi } from "vitest";
import { replaceFileLinkCandidate } from "./markdown-file-link";

// Only the DOM ownership surface used by candidate promotion is needed here.
class Node {
  dataset: Record<string, string> = {};
  children: Node[] = [];
  parent?: Node;
  replacement?: Node;
  attributes: Record<string, string> = {};
  classes = new Set<string>();
  classList = { add: (name: string) => this.classes.add(name) };
  get firstChild(): Node | undefined { return this.children[0]; }
  append(child: Node): void {
    if (child.parent) child.parent.children = child.parent.children.filter((item) => item !== child);
    child.parent = this;
    this.children.push(child);
  }
  setAttribute(key: string, value: string): void { this.attributes[key] = value; }
  cloneNode(): Node { return new Node(); }
  replaceWith(next: Node): void { this.replacement = next; }
}

afterEach(() => vi.unstubAllGlobals());

describe("Markdown file-link promotion", () => {
  it.each(["project", "local"])("prepends one decorative icon and preserves %s link labels and targets", (scope) => {
    const link = new Node();
    vi.stubGlobal("document", { createElement: () => link });
    const candidate = new Node();
    candidate.dataset = { projectFileStartLine: "2", projectFileEndLine: "8" };
    const codeLabel = new Node();
    candidate.append(codeLabel);
    const template = new Node();
    replaceFileLinkCandidate(candidate as unknown as HTMLElement, {
      path: "src/main.ts", projectPath: scope === "project" ? "src/main.ts" : undefined,
    }, template as unknown as SVGElement);

    expect(candidate.replacement).toBe(link);
    expect(link.children).toHaveLength(2);
    expect(link.children[1]).toBe(codeLabel);
    const icon = link.children[0]!;
    expect(icon).not.toBe(template);
    expect(icon.attributes["aria-hidden"]).toBe("true");
    expect(icon.classes.has("markdown-file-link-icon")).toBe(true);
    expect(template.classes.size).toBe(0);
    expect(link.dataset).toEqual(scope === "project"
      ? { projectFile: "src/main.ts", projectFileStartLine: "2", projectFileEndLine: "8" }
      : { localFile: "src/main.ts" });
  });
});
