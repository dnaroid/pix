import { describe, expect, it } from "vitest";
import { render } from "svelte/server";
import SavedSessionRow from "./SavedSessionRow.svelte";
import { buildSessionTree } from "../lib/session-tabs";
import source from "./SavedSessionRow.svelte?raw";

const rows = buildSessionTree([
  { sessionId: "root", cwd: "/project", title: "Parent" },
  { sessionId: "child", cwd: "/project", title: "Child", _meta: { "pix.parentSessionId": "root" } },
]);
function html(index: number, collapsed = false, disabled = false): string {
  return render(SavedSessionRow, { props: {
    row: rows[index]!, collapsed, disabled, date: "09.10.2026",
    onSelect: () => {}, onToggle: () => {}, onActivate: () => {},
  } }).body;
}

describe("SavedSessionRow", () => {
  it("renders decorative SVG geometry instead of text connectors", () => {
    const child = html(1);
    expect(child).toContain('<svg');
    expect(child).toContain('M 9 0 V 10 Q 9 14 13 14 H 23');
    expect(child).toContain('<circle');
    expect(child).not.toMatch(/[├└│]/u);
    expect(child).toContain("Child");
    expect(child).toContain("09.10.2026");
  });

  it("keeps separate selection and keyboard-native rotating disclosure buttons", () => {
    const expanded = html(0);
    expect(expanded.match(/<button\b/g)).toHaveLength(2);
    expect(expanded).toContain('aria-expanded="true"');
    expect(expanded).toContain('Collapse branches of Parent');
    expect(expanded).toContain('rotate-90');
    const collapsed = html(0, true);
    expect(collapsed).toContain('aria-expanded="false"');
    expect(collapsed).toContain('Expand branches of Parent');
    expect(collapsed).toContain('rotate-0');
    expect(collapsed).not.toContain('M 9 21 V 28');
    expect(source).toContain('motion-reduce:transition-none');
    expect(html(1)).not.toContain('aria-expanded');
    expect(html(0, false, true).match(/<button\b[^>]*\sdisabled(?:="[^"]*")?(?:\s|>)/g)).toHaveLength(2);
  });
});
