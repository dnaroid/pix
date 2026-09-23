import { describe, expect, it } from "vitest";
import { isUserBashTool } from "./tool-presentation";
import {
  activityGroupDuration,
  activityGroupPresentationLabels,
  applyDeferredToolResult,
  applySessionUpdate,
  emptyTranscript,
  finalizeTranscriptActivity,
  groupTranscriptItems,
  transcriptFromSessionUpdates,
  type ActivityGroupItem,
  type ToolItem,
  type TranscriptState,
} from "./transcript";

function group(state: TranscriptState): ActivityGroupItem {
  const result = groupTranscriptItems(state.items)[0];
  if (result?.type !== "activity-group") throw new Error("Expected one activity group");
  return result;
}

function tool(id: string): ToolItem {
  return { type: "tool", id: `tool:${id}`, toolCallId: id, name: "read", title: "Read", kind: "read",
    status: "completed", content: "", diffs: [], attachments: [] };
}

describe("mixed transcript activity regressions", () => {
  it("samples active elapsed time from a supplied clock, then preserves the final span", () => {
    let state = applySessionUpdate(emptyTranscript, {
      sessionUpdate: "agent_thought_chunk", messageId: "t1", content: { type: "text", text: "Plan" },
    }, 100);
    state = applySessionUpdate(state, {
      sessionUpdate: "tool_call", toolCallId: "read-1", name: "read", title: "Read", status: "in_progress",
    }, 200);

    const active = groupTranscriptItems(state.items)[0];
    if (active?.type !== "activity-group") throw new Error("Expected an activity group");
    expect(active).toMatchObject({ active: true, startedAtMs: 100 });
    expect(active.durationMs).toBeUndefined();
    expect(activityGroupDuration(active, 1_600)).toBe(1_500);

    state = applySessionUpdate(state, {
      sessionUpdate: "tool_call_update", toolCallId: "read-1", status: "completed",
    }, 2_000);
    const settled = group(state);
    expect(settled).toMatchObject({ active: false, durationMs: 1_900 });
    expect(activityGroupDuration(settled, 99_000)).toBe(1_900);
  });

  it("visits timing metadata only linearly without mutating the input", () => {
    let timingReads = 0;
    const items = Object.freeze(Array.from({ length: 400 }, (_, index) => Object.freeze({
      ...tool(String(index)),
      get startedAtMs() { timingReads += 1; return index * 10; },
      endedAtMs: index * 10 + 5,
    })));
    const result = group({ items });
    expect(result.entries).toEqual(items);
    expect(result.entries[0]).toBe(items[0]);
    expect(result.durationMs).toBe(3_995);
    // Count work instead of using a machine-dependent wall-clock assertion.
    expect(timingReads).toBeLessThan(items.length * 10);
  });

  it("builds collapsed labels and bash classification without formatting large inputs", () => {
    const item: ToolItem = {
      ...tool("large"),
      get rawInput() { throw new Error("Collapsed header must not inspect the tool payload"); },
    };
    expect(activityGroupPresentationLabels([item])).toEqual([{ name: "read", active: false }]);
    expect(isUserBashTool(item)).toBe(false);
  });

  it("presents SKILL.md reads as active skill rows in live and replayed transcripts", () => {
    const active = applySessionUpdate(emptyTranscript, {
      sessionUpdate: "tool_call", toolCallId: "skill-live", name: "read", title: "Read", status: "in_progress",
      rawInput: { path: "/repo/tools/demo/SKILL.md" },
    });
    expect(activityGroupPresentationLabels(group(active).entries)).toEqual([{ name: "skill demo", active: true }]);
    expect(group(active).tools[0]?.skillName).toBe("demo");
    const replay = group(transcriptFromSessionUpdates([{
      sessionUpdate: "tool_call", toolCallId: "skill-replay", name: "read", title: "Read", status: "completed",
      rawInput: { path: "/repo/tools/demo/SKILL.md" },
    }]));
    expect(activityGroupPresentationLabels(replay.entries)).toEqual([{ name: "skill demo", active: false }]);
    // ACP replay's initial page carries titles/locations, not rawInput. Result
    // hydration must not be required for the collapsed header or child label.
    const lightReplay = group(transcriptFromSessionUpdates([{
      sessionUpdate: "tool_call", toolCallId: "light-read", name: "read",
      title: "Read .pi/skills/pix-desktop-frontend/SKILL.md", status: "completed",
    }]));
    expect(lightReplay.tools[0]?.skillName).toBe("pix-desktop-frontend");
    expect(activityGroupPresentationLabels(lightReplay.entries)).toEqual([
      { name: "skill pix-desktop-frontend", active: false },
    ]);
    const located = applySessionUpdate(emptyTranscript, {
      sessionUpdate: "tool_call", toolCallId: "located-read", name: "read", title: "Read", status: "in_progress",
      locations: [{ path: "/repo/.pi/skills/pi-sdk/SKILL.md" }],
    });
    expect(activityGroupPresentationLabels(group(located).entries)).toEqual([{ name: "skill pi-sdk", active: true }]);
    const laterTitle = applySessionUpdate(emptyTranscript, {
      sessionUpdate: "tool_call", toolCallId: "later-title", name: "read", title: "Read", status: "in_progress",
    });
    const titled = applySessionUpdate(laterTitle, {
      sessionUpdate: "tool_call_update", toolCallId: "later-title", title: "Read .pi/skills/pi-tools-suite/SKILL.md",
    });
    expect(activityGroupPresentationLabels(group(titled).entries)).toEqual([
      { name: "skill pi-tools-suite", active: true },
    ]);
    const ordinary = applySessionUpdate(emptyTranscript, {
      sessionUpdate: "tool_call", toolCallId: "ordinary", name: "read", title: "Read", status: "completed",
      rawInput: { path: "/repo/README.md" },
    });
    expect(activityGroupPresentationLabels(group(ordinary).entries)).toEqual([{ name: "read", active: false }]);
    const shell = applySessionUpdate(emptyTranscript, {
      sessionUpdate: "tool_call", toolCallId: "shell-skill", name: "shell", title: "Shell", status: "in_progress",
      rawInput: { command: "cat /repo/skills/simplify/SKILL.md" },
    });
    expect(group(shell).tools[0]?.skillName).toBe("simplify");
    expect(activityGroupPresentationLabels(group(shell).entries)).toEqual([{ name: "skill simplify", active: true }]);
    const mutation = applySessionUpdate(emptyTranscript, {
      sessionUpdate: "tool_call", toolCallId: "shell-write", name: "shell", title: "Shell", status: "completed",
      rawInput: { command: "cat /repo/skills/simplify/SKILL.md > /tmp/SKILL.md" },
    });
    expect(activityGroupPresentationLabels(group(mutation).entries)).toEqual([{ name: "shell", active: false }]);
    const updated = applySessionUpdate(ordinary, {
      sessionUpdate: "tool_call_update", toolCallId: "ordinary", status: "in_progress",
      rawInput: { path: "/repo/skills/demo/SKILL.md" },
    });
    expect(activityGroupPresentationLabels(group(updated).entries)).toEqual([{ name: "skill demo", active: true }]);
    const settled = applySessionUpdate(updated, {
      sessionUpdate: "tool_call_update", toolCallId: "ordinary", status: "completed",
    });
    expect(activityGroupPresentationLabels(group(settled).entries)).toEqual([{ name: "skill demo", active: false }]);
    const inputFirst = applySessionUpdate(emptyTranscript, {
      sessionUpdate: "tool_call_update", toolCallId: "late-name", status: "in_progress",
      rawInput: { path: "/repo/skills/demo/SKILL.md" },
    });
    const named = applySessionUpdate(inputFirst, {
      sessionUpdate: "tool_call_update", toolCallId: "late-name", name: "read", status: "completed",
    });
    expect(activityGroupPresentationLabels(group(named).entries)).toEqual([{ name: "skill demo", active: false }]);
    const bareShell = applySessionUpdate(emptyTranscript, {
      sessionUpdate: "tool_call", toolCallId: "bare-shell", name: "shell", title: "Shell", status: "completed",
      rawInput: { command: "cat SKILL.md", cwd: "/repo/skills/demo" },
    });
    expect(group(bareShell).tools[0]?.skillName).toBe("demo");
  });

  it("moves highlights across thought/tool boundaries, parallel completions and prompt settlement", () => {
    let state = applySessionUpdate(emptyTranscript, {
      sessionUpdate: "agent_thought_chunk", messageId: "t1", content: { type: "text", text: "Plan" },
    }, 100);
    const id = group(state).id;
    expect(activityGroupPresentationLabels(group(state).entries)).toEqual([{ name: "thinking", active: true }]);
    state = applySessionUpdate(state, {
      sessionUpdate: "tool_call", toolCallId: "r1", name: "read", title: "Read", status: "in_progress",
    }, 200);
    state = applySessionUpdate(state, {
      sessionUpdate: "tool_call", toolCallId: "s1", name: "shell", title: "Shell", status: "in_progress",
    }, 250);
    expect(activityGroupPresentationLabels(group(state).entries)).toEqual([
      { name: "thinking", active: false }, { name: "read", active: true }, { name: "shell", active: true },
    ]);
    state = applySessionUpdate(state, {
      sessionUpdate: "tool_call_update", toolCallId: "r1", status: "completed",
    }, 300);
    state = applySessionUpdate(state, {
      sessionUpdate: "agent_thought_chunk", messageId: "t2", content: { type: "text", text: "Compare" },
    }, 350);
    state = applyDeferredToolResult(state, {
      sessionUpdate: "tool_call_update", toolCallId: "r1", status: "completed",
      content: [{ type: "content", content: { type: "text", text: "Lazy body" } }],
      _meta: { "pix.activityTiming": { endedAtMs: 300 } },
    });
    expect(activityGroupPresentationLabels(group(state).entries)).toEqual([
      { name: "thinking", active: true }, { name: "read", active: false }, { name: "shell", active: true },
    ]);
    state = applySessionUpdate(state, {
      sessionUpdate: "tool_call_update", toolCallId: "s1", status: "failed",
    }, 400);
    expect(group(state)).toMatchObject({ id, status: "in_progress", active: true });
    expect(group(state).tools.find((entry) => entry.toolCallId === "s1")).toMatchObject({ status: "failed" });
    state = finalizeTranscriptActivity(state, 500);
    expect(group(state)).toMatchObject({ id, status: "completed", active: false, durationMs: 400 });
    expect(group(state).tools.find((entry) => entry.toolCallId === "s1")).toMatchObject({ status: "failed" });
    expect(activityGroupPresentationLabels(group(state).entries).every((label) => !label.active)).toBe(true);
  });
});
