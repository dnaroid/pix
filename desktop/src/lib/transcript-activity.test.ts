import { describe, expect, it } from "vitest";
import { isUserBashTool } from "./tool-presentation";
import {
  activityGroupDuration,
  activityGroupHeading,
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

  it("builds the collapsed heading and bash classification without formatting large inputs", () => {
    const item: ToolItem = {
      ...tool("large"),
      get rawInput() { throw new Error("Collapsed header must not inspect the tool payload"); },
    };
    expect(activityGroupHeading([item])).toEqual({ action: "Completed", active: false, moreCount: 0, failed: false });
    expect(activityGroupPresentationLabels([item])).toEqual([{ name: "read", tone: "inspect" }]);
    expect(isUserBashTool(item)).toBe(false);
  });

  it("presents SKILL.md reads as active instruction reads in live and replayed transcripts", () => {
    const active = applySessionUpdate(emptyTranscript, {
      sessionUpdate: "tool_call", toolCallId: "skill-live", name: "read", title: "Read", status: "in_progress",
      rawInput: { path: "/repo/tools/demo/SKILL.md" },
    });
    expect(activityGroupHeading(group(active).entries)).toEqual({ action: "Reading instructions", active: true, moreCount: 0, failed: false });
    expect(group(active).tools[0]?.skillName).toBe("demo");
    const replay = group(transcriptFromSessionUpdates([{
      sessionUpdate: "tool_call", toolCallId: "skill-replay", name: "read", title: "Read", status: "completed",
      rawInput: { path: "/repo/tools/demo/SKILL.md" },
    }]));
    expect(activityGroupHeading(replay.entries)).toEqual({ action: "Completed", active: false, moreCount: 0, failed: false });
    // ACP replay's initial page carries titles/locations, not rawInput. Result
    // hydration must not be required for the collapsed header or child label.
    const lightReplay = group(transcriptFromSessionUpdates([{
      sessionUpdate: "tool_call", toolCallId: "light-read", name: "read",
      title: "Read .pi/skills/pix-desktop-frontend/SKILL.md", status: "completed",
    }]));
    expect(lightReplay.tools[0]?.skillName).toBe("pix-desktop-frontend");
    const located = applySessionUpdate(emptyTranscript, {
      sessionUpdate: "tool_call", toolCallId: "located-read", name: "read", title: "Read", status: "in_progress",
      locations: [{ path: "/repo/.pi/skills/pi-sdk/SKILL.md" }],
    });
    expect(activityGroupHeading(group(located).entries)).toEqual({ action: "Reading instructions", active: true, moreCount: 0, failed: false });
    const laterTitle = applySessionUpdate(emptyTranscript, {
      sessionUpdate: "tool_call", toolCallId: "later-title", name: "read", title: "Read", status: "in_progress",
    });
    const titled = applySessionUpdate(laterTitle, {
      sessionUpdate: "tool_call_update", toolCallId: "later-title", title: "Read .pi/skills/pi-tools-suite/SKILL.md",
    });
    expect(activityGroupHeading(group(titled).entries)).toEqual({ action: "Reading instructions", active: true, moreCount: 0, failed: false });
    const ordinary = applySessionUpdate(emptyTranscript, {
      sessionUpdate: "tool_call", toolCallId: "ordinary", name: "read", title: "Read", status: "completed",
      rawInput: { path: "/repo/README.md" },
    });
    expect(activityGroupHeading(group(ordinary).entries)).toEqual({ action: "Completed", active: false, moreCount: 0, failed: false });
    const shell = applySessionUpdate(emptyTranscript, {
      sessionUpdate: "tool_call", toolCallId: "shell-skill", name: "shell", title: "Shell", status: "in_progress",
      rawInput: { command: "cat /repo/skills/simplify/SKILL.md" },
    });
    expect(group(shell).tools[0]?.skillName).toBe("simplify");
    expect(activityGroupHeading(group(shell).entries)).toEqual({ action: "Reading instructions", active: true, moreCount: 0, failed: false });
    const mutation = applySessionUpdate(emptyTranscript, {
      sessionUpdate: "tool_call", toolCallId: "shell-write", name: "shell", title: "Shell", status: "completed",
      rawInput: { command: "cat /repo/skills/simplify/SKILL.md > /tmp/SKILL.md" },
    });
    expect(activityGroupHeading(group(mutation).entries)).toEqual({ action: "Completed", active: false, moreCount: 0, failed: false });
    const updated = applySessionUpdate(ordinary, {
      sessionUpdate: "tool_call_update", toolCallId: "ordinary", status: "in_progress",
      rawInput: { path: "/repo/skills/demo/SKILL.md" },
    });
    expect(activityGroupHeading(group(updated).entries)).toEqual({ action: "Reading instructions", active: true, moreCount: 0, failed: false });
    const settled = applySessionUpdate(updated, {
      sessionUpdate: "tool_call_update", toolCallId: "ordinary", status: "completed",
    });
    expect(activityGroupHeading(group(settled).entries)).toEqual({ action: "Completed", active: false, moreCount: 0, failed: false });
    const inputFirst = applySessionUpdate(emptyTranscript, {
      sessionUpdate: "tool_call_update", toolCallId: "late-name", status: "in_progress",
      rawInput: { path: "/repo/skills/demo/SKILL.md" },
    });
    const named = applySessionUpdate(inputFirst, {
      sessionUpdate: "tool_call_update", toolCallId: "late-name", name: "read", status: "completed",
    });
    expect(activityGroupHeading(group(named).entries)).toEqual({ action: "Completed", active: false, moreCount: 0, failed: false });
    const bareShell = applySessionUpdate(emptyTranscript, {
      sessionUpdate: "tool_call", toolCallId: "bare-shell", name: "shell", title: "Shell", status: "completed",
      rawInput: { command: "cat SKILL.md", cwd: "/repo/skills/demo" },
    });
    expect(group(bareShell).tools[0]?.skillName).toBe("demo");
  });

  it("maps normalized tool metadata to one deterministic neutral header action", () => {
    const cases: readonly (readonly [Partial<ToolItem>, string])[] = [
      [{ name: "read" }, "Reading code"],
      [{ name: "read_file" }, "Reading code"],
      [{ name: "grep" }, "Searching project"],
      [{ name: "repo_knowledge" }, "Searching project"],
      [{ name: "repo_search" }, "Searching project"],
      [{ name: "edit" }, "Making changes"],
      [{ name: "apply_patch" }, "Making changes"],
      [{ name: "ast_apply" }, "Making changes"],
      [{ name: "bash" }, "Running command"],
      [{ name: "shell_command" }, "Running command"],
      [{ name: "web_search" }, "Searching the web"],
      [{ name: "web_fetch" }, "Reading web page"],
      [{ name: "subagents", kind: "other" }, "Managing agents"],
      [{ name: "task", kind: "other" }, "Managing agents"],
      [{ name: "question", kind: "other" }, "Waiting for input"],
      [{ name: "todo", kind: "other" }, "Updating plan"],
      [{ name: "update_plan", kind: "other" }, "Updating plan"],
      [{ name: "mystery", kind: "other" }, "Running tool"],
      [{ name: "orchestrate", kind: "unknown" }, "Running tool"],
      // No programmatic name: fall back through the title to the tool kind.
      [{ name: undefined, title: "Discover files", kind: "search" }, "Searching project"],
      [{ name: undefined, title: "Inspect file", kind: "read" }, "Reading code"],
      [{ name: undefined, title: "Rewrite file", kind: "mutation" }, "Making changes"],
      [{ name: undefined, title: "Launch process", kind: "execute" }, "Running command"],
      [{ name: undefined, title: "Odd tool", kind: "other" }, "Running tool"],
    ];
    for (const [patch, action] of cases) {
      const entry: ToolItem = { ...tool("case"), status: "in_progress", ...patch };
      expect(activityGroupHeading([entry]), `${entry.name ?? entry.title}`).toEqual({
        action, active: true, moreCount: 0, failed: false,
      });
    }
  });

  it("labels the collapsed comma list with first-seen names and native tones regardless of liveness", () => {
    const thought = {
      type: "message",
      id: "thought:labels",
      role: "thought",
      text: "Plan",
      attachments: [],
      startedAtMs: 1_000,
      endedAtMs: 1_500,
    } as const;
    const settledRead = { ...tool("read-done"), status: "completed" } as const;
    const liveGrep = { ...tool("grep-live"), name: "grep", status: "in_progress" } as const;
    const settledBash = { ...tool("bash-done"), name: "bash", status: "completed" } as const;
    expect(activityGroupPresentationLabels([thought, settledRead, liveGrep, settledBash, settledRead])).toEqual([
      { name: "thinking", tone: undefined },
      { name: "read", tone: "inspect" },
      { name: "grep", tone: "search" },
      { name: "bash", tone: "execute" },
    ]);
    // Completed names keep their native tones: coloring never depends on liveness.
    expect(activityGroupPresentationLabels([settledRead])).toEqual([{ name: "read", tone: "inspect" }]);
    const skillRead: ToolItem = {
      ...tool("skill-read"),
      skillName: "demo",
      title: "Read .pi/skills/demo/SKILL.md",
      status: "completed",
    };
    expect(activityGroupPresentationLabels([skillRead])).toEqual([{ name: "skill demo", tone: "skill" }]);
    const compress = { ...tool("compress"), name: "compress", status: "completed" } as const;
    expect(activityGroupPresentationLabels([skillRead, compress])).toEqual([
      { name: "skill demo", tone: "skill" },
      { name: "compress", tone: "compress" },
    ]);
    const unknown = { ...tool("odd"), name: "orchestrate", kind: "unknown", status: "completed" } as const;
    expect(activityGroupPresentationLabels([unknown])).toEqual([{ name: "orchestrate", tone: "neutral" }]);
  });

  it("does not guess commands or subagent status payloads from raw input", () => {
    const testRunner: ToolItem = {
      ...tool("test-runner"),
      name: "bash",
      status: "in_progress",
      rawInput: { command: "npm test -- --run" },
    };
    expect(activityGroupHeading([testRunner])).toMatchObject({ action: "Running command", active: true });
    const subagentStatus: ToolItem = {
      ...tool("agent-status"),
      name: "subagents",
      kind: "other",
      status: "in_progress",
      rawInput: { action: "status" },
    };
    expect(activityGroupHeading([subagentStatus])).toMatchObject({ action: "Managing agents", active: true });
  });

  it("selects the most recent active entry and counts the remaining active entries", () => {
    const bash = { ...tool("bash-run"), name: "bash", status: "in_progress" } as const;
    const grep = { ...tool("grep-run"), name: "grep", status: "in_progress" } as const;
    const thought = {
      type: "message",
      id: "thought:live",
      role: "thought",
      text: "Deciding",
      attachments: [],
      startedAtMs: 1_000,
    } as const;

    expect(activityGroupHeading([bash, grep])).toEqual({ action: "Searching project", active: true, moreCount: 1, failed: false });
    expect(activityGroupHeading([bash, grep, thought])).toEqual({ action: "Thinking", active: true, moreCount: 2, failed: false });
    expect(activityGroupHeading([thought, grep])).toEqual({ action: "Searching project", active: true, moreCount: 1, failed: false });
    // A parallel call that already settled neither selects the action nor adds to the count.
    const done = { ...tool("done-read"), status: "completed" } as const;
    expect(activityGroupHeading([done, grep])).toEqual({ action: "Searching project", active: true, moreCount: 0, failed: false });
  });

  it("settles to Failed when any tool call failed and never reports untimed history as active", () => {
    const failed = { ...tool("failed-read"), status: "failed" } as const;
    const completed = { ...tool("ok-write"), name: "write", status: "completed" } as const;
    expect(activityGroupHeading([completed, failed])).toEqual({ action: "Failed", active: false, moreCount: 0, failed: true });
    expect(activityGroupHeading([completed])).toEqual({ action: "Completed", active: false, moreCount: 0, failed: false });

    const untimedThought = {
      type: "message",
      id: "thought:history",
      role: "thought",
      text: "Historical thought",
      attachments: [],
    } as const;
    expect(activityGroupHeading([untimedThought, completed])).toEqual({ action: "Completed", active: false, moreCount: 0, failed: false });
    const timedThought = { ...untimedThought, id: "thought:live", startedAtMs: 500 } as const;
    expect(activityGroupHeading([timedThought])).toEqual({ action: "Thinking", active: true, moreCount: 0, failed: false });
    // A failed tool beside a still-running call stays live; failure surfaces once settled.
    const running = { ...tool("still-running"), name: "grep", status: "in_progress" } as const;
    expect(activityGroupHeading([failed, running])).toEqual({ action: "Searching project", active: true, moreCount: 0, failed: true });
  });

  it("moves the live action across thought/tool boundaries, parallel completions and prompt settlement", () => {
    let state = applySessionUpdate(emptyTranscript, {
      sessionUpdate: "agent_thought_chunk", messageId: "t1", content: { type: "text", text: "Plan" },
    }, 100);
    const id = group(state).id;
    expect(activityGroupHeading(group(state).entries)).toEqual({ action: "Thinking", active: true, moreCount: 0, failed: false });
    state = applySessionUpdate(state, {
      sessionUpdate: "tool_call", toolCallId: "r1", name: "read", title: "Read", status: "in_progress",
    }, 200);
    state = applySessionUpdate(state, {
      sessionUpdate: "tool_call", toolCallId: "s1", name: "shell", title: "Shell", status: "in_progress",
    }, 250);
    expect(activityGroupHeading(group(state).entries)).toEqual({ action: "Running command", active: true, moreCount: 1, failed: false });
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
    expect(activityGroupHeading(group(state).entries)).toEqual({ action: "Thinking", active: true, moreCount: 1, failed: false });
    state = applySessionUpdate(state, {
      sessionUpdate: "tool_call_update", toolCallId: "s1", status: "failed",
    }, 400);
    expect(group(state)).toMatchObject({ id, status: "in_progress", active: true });
    expect(group(state).tools.find((entry) => entry.toolCallId === "s1")).toMatchObject({ status: "failed" });
    state = finalizeTranscriptActivity(state, 500);
    expect(group(state)).toMatchObject({ id, status: "completed", active: false, durationMs: 400 });
    expect(group(state).tools.find((entry) => entry.toolCallId === "s1")).toMatchObject({ status: "failed" });
    expect(activityGroupHeading(group(state).entries)).toEqual({ action: "Failed", active: false, moreCount: 0, failed: true });
  });
});
