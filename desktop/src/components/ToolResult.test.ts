import { describe, expect, it } from "vitest";
import { render } from "svelte/server";
import type { ToolItem } from "../lib/transcript";
import ToolResult from "./ToolResult.svelte";

const tool: ToolItem = {
  type: "tool", id: "tool-1", toolCallId: "call-1", name: "shell", title: "shell",
  kind: "execute", status: "completed", rawInput: { command: "echo <hello>\necho goodbye", cwd: "/repo" },
  content: "done", diffs: [], attachments: [],
};

describe("tool input and output blocks", () => {
  it("renders escaped full input before labeled output", () => {
    const html = render(ToolResult, { props: { tool } }).body;
    expect(html).toContain('aria-label="Tool input"');
    expect(html).toContain("echo &lt;hello>\necho goodbye");
    expect(html).toContain("cwd: /repo");
    expect(html.indexOf(">Input<")).toBeLessThan(html.indexOf(">Result<"));
    expect(html).toContain("done");
  });
  it("renders input even before a result arrives", () => {
    const html = render(ToolResult, { props: { tool: { ...tool, content: "", status: "in_progress" } } }).body;
    expect(html).toContain(">Input<");
    expect(html).not.toContain(">Result<");
  });
  it("does not add an input block to patch calls", () => {
    const html = render(ToolResult, { props: { tool: { ...tool, name: "apply_patch", rawInput: { input: "*** Begin Patch\n*** End Patch" } } } }).body;
    expect(html).not.toContain('aria-label="Tool input"');
    expect(html).toContain("done");
  });
});
