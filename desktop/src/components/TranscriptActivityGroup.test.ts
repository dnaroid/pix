import { describe, expect, it } from "vitest";
import { render } from "svelte/server";
import { activityIcon } from "../lib/tool-icons";
import { activityIconWindow } from "../lib/activity-icon-window";
import { groupTranscriptItems, type ActivityEntry, type ToolItem } from "../lib/transcript";
import TranscriptActivityGroup from "./TranscriptActivityGroup.svelte";

function tool(id: string, name: string): ToolItem {
  return { type: "tool", id, toolCallId: id, name, title: name, kind: "other",
    status: "completed", content: "", attachments: [], diffs: [] };
}

function header(entries: ActivityEntry[]): string {
  const item = groupTranscriptItems(entries)[0];
  if (item?.type !== "activity-group") throw new Error("Expected activity group");
  return render(TranscriptActivityGroup, { props: {
    item, onLoadToolResult: () => {}, onOpenAttachment: () => {}, onPrepareAttachment: async () => {},
  } }).body.split("</summary>")[0]!;
}

describe("activity icon trail", () => {
  it("hides the horizontal trail in an expanded group while retaining the chevron and duration", () => {
    const html = header([{
      ...tool("user-bash", "bash"), rawInput: { excludeFromContext: true },
      startedAtMs: 1, endedAtMs: 100,
    }]);
    expect(html).toContain("open");
    expect(html).not.toContain("activity-icon-trail");
    expect(html).not.toContain("data-activity-name");
    expect(html).toContain("Tool activity");
    expect(html).toContain("lucide-chevron-right");
    expect(html).toContain("data-activity-duration");
    expect(html.match(/<svg\b/g)).toHaveLength(1);
  });

  it("renders repeated calls in start order, not completion or alphabetical order", () => {
    const html = header([
      { ...tool("a", "read"), startedAtMs: 1, endedAtMs: 100 },
      { ...tool("b", "shell"), startedAtMs: 2, endedAtMs: 3 },
      { ...tool("c", "read"), startedAtMs: 4, endedAtMs: 5 },
    ]);
    expect([...html.matchAll(/data-activity-name="([^"]+)"/g)].map((match) => match[1]))
      .toEqual(["read", "shell", "read"]);
    expect(html.match(/<svg\b/g)).toHaveLength(4); // Chevron plus one icon per call.
    expect(html.match(/title="read"/g)).toHaveLength(2);
    expect(html).toContain('class="sr-only"');
    expect(html).not.toContain("data-activity-entry-id");
    expect(html).toContain("data-activity-duration");
  });

  it("preserves thinking, skill names and unknown tools without reading payloads", () => {
    const html = header([
      { type: "message", id: "t1", role: "thought", text: "", attachments: [] },
      { ...tool("a", "read"), skillName: "simplify" },
      { ...tool("b", "custom_tool"), get rawInput() { throw new Error("No payload access"); } },
      { type: "message", id: "t2", role: "thought", text: "", attachments: [] },
    ]);
    expect([...html.matchAll(/data-activity-name="([^"]+)"/g)].map((match) => match[1]))
      .toEqual(["thinking", "skill simplify", "custom_tool", "thinking"]);
    expect(html.match(/<svg\b/g)).toHaveLength(5);
  });

  it("maps only current tools, with an unknown-tool fallback for retired names", () => {
    expect(activityIcon("functions.shell")).toBe(activityIcon("shell"));
    expect(activityIcon("skill simplify")).toBe(activityIcon("skill"));
    expect(activityIcon("unknown_a")).toBe(activityIcon("unknown_b"));
    const names = ["read", "shell", "ast_grep", "ast_apply", "apply_patch", "codemode", "project_search",
      "project_tasks", "todo", "session", "subagents", "question", "compress", "web_search", "web_fetch", "wiki_conflicts", "skill", "thinking",
      "shell_output", "shell_jobs", "shell_kill", "lookup"];
    for (const name of ["repo_audit", "repo_knowledge", "repo_context", "repo_inspect", "repo_ast",
      "repo_search", "repo_structure", "repo_architecture", "repo_deps", "repo_ask", "repo_explain",
      "read_file", "task", "agent", "brainstorm",
      "project", "projects", "get_plan", "update_plan", "multi_tool_use"]) {
      expect(activityIcon(name), name).toBe(activityIcon("unknown"));
    }
    expect(activityIcon("multi_tool_use.parallel")).toBe(activityIcon("parallel"));
    expect(new Set(names.map((name) => activityIcon(name))).size).toBe(names.length);
    for (const name of names) expect(activityIcon(name)).not.toBe(activityIcon("unknown"));
  });

  it.each([
    ["shell_output", "logs"], ["shell_jobs", "list-tree"],
    ["shell_kill", "octagon-x"], ["lookup", "scan-eye"],
  ])("renders the dedicated %s icon, including namespaced labels", (name, icon) => {
    expect(activityIcon(`functions.${name}`)).toBe(activityIcon(name));
    const html = header([tool(name, name)]);
    expect(html).toContain(`lucide-${icon}`);
    expect(html).not.toContain("lucide-wrench");
  });

  it("shares background shell icons with the Claude aliases", () => {
    expect(activityIcon("BashOutput")).toBe(activityIcon("shell_output"));
    expect(activityIcon("functions.KillShell")).toBe(activityIcon("shell_kill"));
  });

  it("renders a dedicated book alert icon for wiki conflicts, including namespaced labels", () => {
    expect(activityIcon("functions.wiki_conflicts")).toBe(activityIcon("wiki_conflicts"));
    const html = header([tool("wiki", "wiki_conflicts")]);
    expect(html).toContain("lucide-book-alert");
    expect(html).not.toContain("lucide-wrench");
  });

  it("maps the current Claude tool profile, including namespaced and lowercase labels", () => {
    for (const name of ["Read", "Edit", "Write", "Bash", "Grep", "Glob"]) {
      expect(activityIcon(name), name).not.toBe(activityIcon("unknown"));
      expect(activityIcon(`functions.${name}`)).toBe(activityIcon(name));
      expect(activityIcon(name.toLowerCase())).toBe(activityIcon(name));
    }
    expect(activityIcon("Edit")).toBe(activityIcon("apply_patch"));
    expect(activityIcon("Bash")).toBe(activityIcon("shell"));
    expect(activityIcon("Grep")).toBe(activityIcon("project_search"));
    expect(activityIcon("Write")).not.toBe(activityIcon("Edit"));
    expect(activityIcon("Glob")).not.toBe(activityIcon("Grep"));
  });

  it("bounds mounts for long trails while keeping their complete accessible sequence", () => {
    const html = header(Array.from({ length: 10_000 }, (_, index) => tool(String(index), "read")));
    expect(html.match(/data-activity-name=/g)!.length).toBeLessThan(100);
    expect(html.match(/read/g)!.length).toBeGreaterThanOrEqual(10_000);
    expect(html).toContain("159998px");
    expect(activityIconWindow(10_000, 0, 400)).toEqual({ start: 0, end: 29 });
    expect(activityIconWindow(10_000, 159_598, 400)).toEqual({ start: 9970, end: 10_000 });
    expect(activityIconWindow(3, 199_594, 400)).toEqual({ start: 0, end: 3 });
    expect(activityIconWindow(10_000, 159_598, 1000)).toEqual({ start: 9933, end: 10_000 });
  });

  it("shows an image for image reads while preserving the read tooltip and avoiding payload access", () => {
    const html = header([{ ...tool("image", "Read"), imageRead: true,
      get rawInput() { throw new Error("No payload access"); } }]);
    expect(html).toContain("lucide-image");
    expect(html).toContain('title="read"');
    expect(html).not.toContain("lucide-file-text");
  });
});
