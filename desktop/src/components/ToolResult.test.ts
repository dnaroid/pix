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
  it("highlights GDScript read results", () => {
    const html = render(ToolResult, { props: { tool: { ...tool, name: "read", kind: "read", title: "read mission_result.gd:25+50", rawInput: undefined, content: "func display() -> void:\n\tpass" } } }).body;
    expect(html).toContain('data-language="gdscript"');
    expect(html).toContain('sh__token--keyword');
    expect(html).not.toContain('aria-label="Tool input"');
  });
  it("renders escaped full input before labeled output", () => {
    const html = render(ToolResult, { props: { tool } }).body;
    expect(html).toContain('aria-label="Tool input"');
    const text = html.replace(/<[^>]*>/g, "");
    expect(text).toContain("echo &lt;hello&gt;\necho goodbye");
    expect(text).toContain("cwd: /repo");
    expect(html).toContain('data-language="shell"');
    expect(html.indexOf(">Input<")).toBeLessThan(html.indexOf(">Result<"));
    expect(html).toContain("done");
  });
  it("highlights codemode safely without dropping multiline input or options", () => {
    const html = render(ToolResult, { props: { tool: { ...tool, name: "codemode", rawInput: { code: 'const value = "<script>";\ntext(value);', timeout_ms: 1000 } } } }).body;
    expect(html).toContain('data-language="javascript"');
    expect(html).toContain("sh__token--keyword");
    expect(html).not.toContain("<script>");
    expect(html.replace(/<[^>]*>/g, "")).toContain('const value = &quot;&lt;script&gt;&quot;;\ntext(value);');
    expect(html.replace(/<[^>]*>/g, "")).toContain("timeout_ms: 1000");
  });
  it("keeps large code intact with the shared plaintext fallback", () => {
    const code = "x".repeat(33_000);
    const html = render(ToolResult, { props: { tool: { ...tool, name: "codemode", rawInput: { code } } } }).body;
    expect(html).toContain('data-language="plaintext"');
    expect(html).toContain(code);
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
