import { describe, expect, it } from "vitest";
import { hasToolInput, toolInputText } from "./tool-input";

const source = (name: string, rawInput?: unknown) => ({ name, title: name, kind: "other", rawInput });

describe("expanded tool inputs", () => {
  it.each(["codemode", "shell", "bash", "repo_context", "repo_search", "repo_audit", "ast_grep", "ast_apply", "subagents", "brainstorm", "web_search", "question"])("selects %s", (name) => {
    expect(hasToolInput(source(name, { prompt: "full input" }))).toBe(true);
  });
  it.each(["apply_patch", "read", "web_fetch", "todo", "session_search", "unknown"])("leaves %s unchanged", (name) => {
    expect(toolInputText(source(name, { input: "text" }))).toBeUndefined();
  });
  it("handles namespaced and legacy names without inventing missing input", () => {
    expect(hasToolInput(source("functions.shell", "echo hi"))).toBe(true);
    expect(toolInputText({ title: "shell echo hi", kind: "execute", rawInput: "echo hi" })).toBe("echo hi");
    expect(hasToolInput(source("shell"))).toBe(false);
  });
  it("preserves multiline strings and every supplied option", () => {
    const command = "python3 - <<'PY'\nprint(\"hello\")\nPY";
    const text = toolInputText(source("shell", { command, cwd: "/project", timeout: 0 }));
    expect(text).toContain(command);
    expect(text).toContain("cwd: /project");
    expect(text).toContain("timeout: 0");
    expect(text).not.toContain("\\n");
  });
  it("shows nested tasks, questions, arrays, false and null values", () => {
    expect(toolInputText(source("subagents", { tasks: [{ task: "first\nsecond", tools: ["read", "shell"] }], force: false, value: null })))
      .toBe("tasks:\n[1]\ntask:\nfirst\nsecond\n\ntools:\n[1]\nread\n\n[2]\nshell\n\nforce: false\n\nvalue:\nnull");
  });
  it("does not truncate long prompts", () => {
    const code = "x".repeat(100_000);
    expect(toolInputText(source("codemode", code))).toBe(code);
  });
});
