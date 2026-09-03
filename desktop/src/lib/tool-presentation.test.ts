import { describe, expect, it } from "vitest";
import { toolPresentation, toolTone } from "./tool-presentation";

describe("toolPresentation", () => {
  it("formats read paths and ranges like the TUI", () => {
    expect(toolPresentation({
      name: "Read",
      kind: "read",
      title: "Read src/main.ts",
      rawInput: { path: "src/main.ts", offset: 12, limit: 20 },
    })).toEqual({ name: "read", args: "src/main.ts:12+20", tone: "success" });
  });

  it("formats commands and collapses whitespace", () => {
    expect(toolPresentation({
      name: "bash",
      kind: "execute",
      title: "Bash: npm test",
      rawInput: { command: "npm test\n  -- --run" },
    })).toEqual({ name: "bash", args: "npm test -- --run", tone: "warning" });
  });

  it("formats repository tool arguments in TUI order", () => {
    expect(toolPresentation({
      name: "repo_search",
      kind: "other",
      title: "repo_search",
      rawInput: { maxLines: 50, target: "tool rendering", args: ["--exclude-tests"] },
    })).toEqual({
      name: "repo_search",
      args: "target: tool rendering · args: [--exclude-tests] · maxLines: 50",
      tone: "warning",
    });
  });

  it("falls back to splitting legacy ACP titles", () => {
    expect(toolPresentation({ kind: "read", title: "Read src/legacy.ts" })).toEqual({
      name: "read",
      args: "src/legacy.ts",
      tone: "success",
    });
  });
});

describe("toolTone", () => {
  it("matches mutation before the generic ast search prefix", () => {
    expect(toolTone("ast_apply")).toBe("mutation");
    expect(toolTone("ast_grep")).toBe("search");
  });

  it("uses the TUI tones for built-in tool families", () => {
    expect(toolTone("web_search")).toBe("search");
    expect(toolTone("compress")).toBe("info");
    expect(toolTone("question")).toBe("accent");
    expect(toolTone("subagents")).toBe("muted");
    expect(toolTone("custom_tool")).toBe("title");
  });
});
