import { describe, expect, it } from "vitest";
import {
  isShellDiffTool,
  structuredDiffModel,
  unifiedDiffLineKind,
  unifiedDiffModel,
} from "./diff";

describe("structured diff view model", () => {
  it("minimizes unchanged lines and counts real edits", () => {
    const model = structuredDiffModel({
      path: "/repo/src/demo.ts",
      oldText: "const one = 1;\nconst two = 2;",
      newText: "const one = 1;\nconst two = 3;\nconst three = 3;",
    });

    expect(model.path).toBe("/repo/src/demo.ts");
    expect(model.additions).toBe(2);
    expect(model.deletions).toBe(1);
    expect(model.lines.map((line) => line.text)).toEqual([
      " const one = 1;",
      "-const two = 2;",
      "+const two = 3;",
      "+const three = 3;",
    ]);
  });

  it("renders a write without old text as additions", () => {
    const model = structuredDiffModel({ path: "new.ts", newText: "one\ntwo\n" });
    expect(model.lines.map((line) => line.kind)).toEqual(["added", "added"]);
    expect(model.additions).toBe(2);
    expect(model.deletions).toBe(0);
  });
});

describe("unified shell diff view model", () => {
  it("tracks hunk line numbers and strips ANSI styling", () => {
    const model = unifiedDiffModel([
      "\u001b[1mdiff --git a/a.ts b/a.ts\u001b[0m",
      "--- a/a.ts",
      "+++ b/a.ts",
      "@@ -4,2 +4,2 @@",
      " unchanged",
      "-old",
      "+new",
    ].join("\n"));

    expect(model.additions).toBe(1);
    expect(model.deletions).toBe(1);
    expect(model.lines[4]).toMatchObject({ kind: "context", oldLine: 4, newLine: 4 });
    expect(model.lines[5]).toMatchObject({ kind: "removed", oldLine: 5 });
    expect(model.lines[6]).toMatchObject({ kind: "added", newLine: 5 });
    expect(model.lines[0]?.text).toBe("diff --git a/a.ts b/a.ts");
  });

  it("only treats plus and minus markers in column zero as changes", () => {
    expect(unifiedDiffLineKind("-removed")).toBe("removed");
    expect(unifiedDiffLineKind("+added")).toBe("added");
    expect(unifiedDiffLineKind(" - markdown bullet")).toBe("context");
    expect(unifiedDiffLineKind(" + literal plus")).toBe("context");
  });

  it("matches git diff shell commands like the TUI", () => {
    expect(isShellDiffTool("execute", "Bash: git diff -- src")).toBe(true);
    expect(isShellDiffTool("execute", "Bash: npm test && git diff --stat")).toBe(true);
    expect(isShellDiffTool("execute", "Bash: git status")).toBe(false);
    expect(isShellDiffTool("read", "Read git diff.txt")).toBe(false);
  });
});
