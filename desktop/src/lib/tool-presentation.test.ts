import { describe, expect, it } from "vitest";
import { isUserBashTool, skillReadName, toolGroupPresentationNames, toolPresentation, toolTone } from "./tool-presentation";

describe("toolPresentation", () => {
  it("formats read paths and ranges like the TUI", () => {
    expect(toolPresentation({
      name: "Read",
      kind: "read",
      title: "Read src/main.ts",
      rawInput: { path: "src/main.ts", offset: 12, limit: 20 },
    })).toEqual({ name: "read", args: "src/main.ts:12+20", tone: "inspect" });
  });

  it("presents cached skill reads by skill name and keeps ordinary reads unchanged", () => {
    expect(skillReadName("read", undefined, undefined, "Read .pi/skills/pi-sdk/SKILL.md")).toBe("pi-sdk");
    expect(skillReadName("read", undefined, "/repo/skills/demo/SKILL.md", "Read")).toBe("demo");
    expect(skillReadName("shell", undefined, undefined, "Shell cat /repo/skills/demo/SKILL.md")).toBeUndefined();
    expect(skillReadName("read", undefined, undefined, "Read /repo/README.md")).toBeUndefined();
    expect(toolPresentation({
      name: "read", kind: "read", title: "Read SKILL.md",
      rawInput: { path: "/repo/skills/simplify/SKILL.md", offset: 1, limit: 100 }, skillName: "simplify",
    })).toEqual({ name: "skill", args: "simplify", tone: "context" });
    expect(toolPresentation({
      name: "read", kind: "read", title: "Read README.md", rawInput: { path: "README.md" },
    })).toEqual({ name: "read", args: "README.md", tone: "inspect" });
  });

  it("formats commands and collapses whitespace", () => {
    expect(toolPresentation({
      name: "bash",
      kind: "execute",
      title: "Bash: npm test",
      rawInput: { command: "npm test\n  -- --run" },
    })).toEqual({ name: "bash", args: "npm test -- --run", tone: "execute" });
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
      tone: "search",
    });
  });

  it("prioritizes new repository knowledge queries and every audited path", () => {
    expect(toolPresentation({
      name: "repo_ask", kind: "other", title: "Repo Ask",
      rawInput: { budget: 2000, query: "How are tool rows rendered?", maxLines: 80 },
    })).toEqual({
      name: "repo_ask", args: "query: How are tool rows rendered? · budget: 2000 · maxLines: 80", tone: "search",
    });
    expect(toolPresentation({
      name: "repo_context", kind: "other", title: "Repo Context",
      rawInput: { maxTests: 4, pathPrefix: "desktop/src", query: "tool row contract", budget: 1400 },
    })).toEqual({
      name: "repo_context", args: "query: tool row contract · pathPrefix: desktop/src · budget: 1400 · maxTests: 4", tone: "inspect",
    });
    expect(toolPresentation({
      name: "repo_audit", kind: "other", title: "Repo Audit",
      rawInput: { noSemantic: true, paths: ["desktop/src/lib/tool-presentation.ts", "desktop/src/lib/tool-presentation.test.ts", "specs/desktop-tool-rows.md", "desktop/src/lib/transcript.ts"] },
    })).toEqual({
      name: "repo_audit",
      args: "paths: [desktop/src/lib/tool-presentation.ts, desktop/src/lib/tool-presentation.test.ts, specs/desktop-tool-rows.md, desktop/src/lib/transcript.ts] · noSemantic: true",
      tone: "inspect",
    });
  });

  it("preserves historical repository knowledge headers and fallback titles", () => {
    expect(toolPresentation({
      name: "repo_knowledge", kind: "other", title: "Repo knowledge",
      rawInput: { action: "search", query: "old question" },
    })).toEqual({ name: "repo_knowledge", args: "action: search · query: old question", tone: "search" });
    expect(toolPresentation({ kind: "other", title: "repo_ask: old query" })).toEqual({
      name: "repo_ask", args: "old query", tone: "search",
    });
  });

  it("falls back to splitting legacy ACP titles", () => {
    expect(toolPresentation({ kind: "read", title: "Read src/legacy.ts" })).toEqual({
      name: "read",
      args: "src/legacy.ts",
      tone: "inspect",
    });
  });

  it("deduplicates grouped tool names while preserving first-seen order", () => {
    expect(toolGroupPresentationNames([
      { name: "Todo", kind: "other", title: "Todo" },
      { name: "todo", kind: "other", title: "Todo again" },
      { name: "repo_knowledge", kind: "other", title: "Repo knowledge" },
    ])).toBe("todo, repo_knowledge");
  });

  it("distinguishes Desktop one-shot user bash rows from model bash tools", () => {
    expect(isUserBashTool({
      name: "bash",
      kind: "execute",
      title: "Bash: pwd",
      rawInput: { command: "pwd", excludeFromContext: false },
    })).toBe(true);
    expect(isUserBashTool({
      name: "bash",
      kind: "execute",
      title: "Bash (no context): git status",
      rawInput: { command: "git status", excludeFromContext: true },
    })).toBe(true);
    expect(isUserBashTool({
      name: "bash",
      kind: "execute",
      title: "Bash: npm test",
      rawInput: { command: "npm test" },
    })).toBe(false);
  });
});

describe("toolTone", () => {
  it("matches mutation before the generic ast search prefix", () => {
    expect(toolTone("ast_apply")).toBe("mutation");
    expect(toolTone("ast_grep")).toBe("search");
  });

  it("uses operation roles instead of outcome semantics for tool families", () => {
    expect(toolTone("read_file")).toBe("inspect");
    expect(toolTone("web_search")).toBe("search");
    expect(toolTone("shell")).toBe("execute");
    expect(toolTone("compress")).toBe("context");
    expect(toolTone("question")).toBe("interact");
    expect(toolTone("subagents")).toBe("agent");
    expect(toolTone("custom_tool")).toBe("neutral");
  });

  it("uses ACP tool kind as a semantic fallback", () => {
    expect(toolTone("vendor_reader", "read")).toBe("inspect");
    expect(toolTone("vendor_runner", "execute")).toBe("execute");
    expect(toolTone("vendor_editor", "edit")).toBe("mutation");
  });

  it("colors multi-action repository knowledge by the requested operation", () => {
    expect(toolTone("repo_knowledge", "other", { action: "context" })).toBe("inspect");
    expect(toolTone("repo_knowledge", "other", { action: "search" })).toBe("search");
    expect(toolTone("repo_knowledge", "other", { action: "record" })).toBe("mutation");
    expect(toolTone("repo_knowledge", "other", { action: "remove" })).toBe("mutation");
  });
});
