import { describe, expect, it } from "vitest";
import {
  mutationDiffPresentations,
  mutationOutputLines,
  toolGroupAttention,
  toolLspAttention,
} from "./tool-output";
import type { ToolItem } from "./transcript";

describe("mutation diff presentation", () => {
  it("keeps explicit ACP diffs authoritative", () => {
    const tool = mutationTool({
      name: "edit",
      rawInput: { path: "a.ts", edits: [{ oldText: "wrong", newText: "ignored" }] },
      diffs: [{ path: "/repo/a.ts", oldText: "old", newText: "new" }],
    });

    const [diff] = mutationDiffPresentations(tool);
    expect(diff?.model.path).toBe("/repo/a.ts");
    expect(diff?.model.lines.map((line) => line.text)).toEqual(["-old", "+new"]);
  });

  it("reconstructs replayed edit and write diffs from raw input", () => {
    const edit = mutationDiffPresentations(mutationTool({
      name: "Edit",
      path: "/repo/a.ts",
      rawInput: { file_path: "a.ts", old_string: "const a = 1;", new_string: "const a = 2;" },
    }));
    const write = mutationDiffPresentations(mutationTool({
      name: "write",
      path: "/repo/new.ts",
      rawInput: { path: "new.ts", content: "export {};\n" },
    }));

    expect(edit[0]?.model.lines.map((line) => line.kind)).toEqual(["removed", "added"]);
    expect(write[0]?.model.lines.map((line) => line.text)).toEqual(["+export {};"]);
  });

  it("uses the completed edit patch when result details provide full context", () => {
    const [diff] = mutationDiffPresentations(mutationTool({
      name: "edit",
      path: "/repo/a.ts",
      rawOutput: { patch: "--- a/a.ts\n+++ b/a.ts\n@@ -2,2 +2,2 @@\n context\n-old\n+new" },
      diffs: [{ path: "/repo/a.ts", oldText: "old", newText: "new" }],
    }));

    expect(diff?.label).toBe("/repo/a.ts");
    expect(diff?.model.lines).toEqual(expect.arrayContaining([
      expect.objectContaining({ text: " context", oldLine: 2, newLine: 2 }),
      expect.objectContaining({ text: "-old", oldLine: 3 }),
      expect.objectContaining({ text: "+new", newLine: 3 }),
    ]));
  });

  it("renders Begin Patch and unified input as diff surfaces", () => {
    const beginPatch = mutationDiffPresentations(mutationTool({
      name: "apply_patch",
      rawInput: {
        input: [
          "*** Begin Patch",
          "*** Update File: a.ts",
          "@@",
          "-old",
          "+new",
          "*** End Patch",
        ].join("\n"),
      },
    }));
    const unified = mutationDiffPresentations(mutationTool({
      name: "functions.apply_patch",
      rawInput: { patch: "--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new" },
    }));

    expect(beginPatch[0]).toMatchObject({ label: "apply_patch", model: { additions: 1, deletions: 1 } });
    expect(unified[0]).toMatchObject({ label: "apply_patch", model: { additions: 1, deletions: 1 } });
  });

  it("does not present a failed requested mutation as an applied diff", () => {
    expect(mutationDiffPresentations(mutationTool({
      name: "apply_patch",
      status: "failed",
      rawInput: { input: "*** Begin Patch\n*** Add File: a.ts\n+x\n*** End Patch" },
    }))).toEqual([]);
  });
});

describe("mutation diagnostics presentation", () => {
  it("matches TUI LSP attention severity and aggregates groups", () => {
    const warning = mutationTool({
      name: "apply_patch",
      content: "Success\n\nLSP diagnostics:\n\n✅ typescript: no diagnostics",
    });
    const error = mutationTool({
      name: "edit",
      content: "LSP diagnostics:\n\n󰀦 typescript:\na.ts:1:1 - error TS1: broken",
    });

    expect(toolLspAttention(warning)).toBe("warning");
    expect(toolLspAttention(error)).toBe("error");
    expect(toolGroupAttention([warning, error])).toBe("error");
  });

  it("styles LSP and comment-checker lines while preserving order", () => {
    const lines = mutationOutputLines([
      "Success. Updated a.ts",
      "LSP diagnostics:",
      "✅ typescript: no diagnostics",
      "---",
      "💬 comment-checker — unnecessary comments",
      "a.ts  4:filler",
      "---",
    ].join("\n"));

    expect(lines.map((line) => line.text)).toEqual([
      "Success. Updated a.ts",
      "LSP diagnostics:",
      "✅ typescript: no diagnostics",
      "---",
      "💬 comment-checker — unnecessary comments",
      "a.ts  4:filler",
      "---",
    ]);
    expect(lines.map((line) => line.tone)).toEqual([
      "default",
      "label",
      "success",
      "default",
      "warning",
      "warning",
      "warning",
    ]);
  });
});

function mutationTool(overrides: Partial<ToolItem> = {}): ToolItem {
  return {
    type: "tool",
    id: "tool:mutation",
    toolCallId: "mutation",
    name: "edit",
    title: "Edit a.ts",
    kind: "edit",
    status: "completed",
    content: "",
    diffs: [],
    attachments: [],
    ...overrides,
  };
}
