import { describe, expect, it } from "vitest";
import { inferToolAction } from "./tool-activity";
import { applySessionUpdate, applySessionUpdates, transcriptFromSessionUpdates } from "./transcript-reducer";
import { composerActivity } from "./composer-activity";
import type { ToolItem } from "./transcript-types";

const shell = (command: unknown) => inferToolAction({ name: "functions.shell", title: "shell", kind: "execute", rawInput: { command } });
describe("safe ingestion-time activity inference", () => {
  it.each([
    ["npm test -- file.test.ts", "Running tests"],
    ["npm --prefix desktop run build:web", "Building project"],
    ["pnpm -C desktop run check", "Checking project"],
    ["yarn typecheck", "Checking project"],
    ["bun run test:unit", "Running tests"],
    ["npx vitest run", "Running tests"],
    ["pytest tests", "Running tests"],
    ["cargo test", "Running tests"],
    ["cargo check", "Checking project"],
    ["go build ./...", "Building project"],
    ["npx tsc --noEmit", "Checking project"],
    ["npx vite build", "Building project"],
  ])("classifies %s", (command, action) => expect(shell(command)).toBe(action));

  it.each([
    "echo npm test", "grep test log.txt", "npm install test", "npm run contest",
    "npm run test && npm run build", "cd desktop; npm test", "npm test > log", "npm test\nexit 0",
    "npm test --help", "pytest --version", "npx --yes vitest", "env KEY=secret npm test",
    "npm --dir desktop test", "yarn -C desktop test",
    "npm test $(echo secret)", "npm test `echo secret`", "npm test 'quoted arg'", "npm test\u202e",
    "a".repeat(4097), undefined, { command: "npm test" },
  ])("falls back for ambiguous/non-executing input %j", (command) => expect(shell(command)).toBeUndefined());

  it.each([
    ["spawn", "Starting agents"], ["wait", "Waiting for agents"],
    ["status", "Checking agents"], ["stop", "Stopping agents"],
    ["result", undefined], ["cleanup", undefined], ["wait SECRET", undefined],
  ])("classifies only exact subagents action %s", (action, expected) => {
    expect(inferToolAction({ name: "subagents", title: "subagents", kind: "other", rawInput: { action } })).toBe(expected);
  });

  it("ignores commands on unrelated tools", () => {
    expect(inferToolAction({ name: "session", title: "session", kind: "other", rawInput: { action: "unknown" } })).toBeUndefined();
    expect(inferToolAction({ name: "read", title: "npm test", kind: "read", rawInput: { command: "npm test" } })).toBeUndefined();
  });

  it.each([
    [{ action: "name", name: "Short title" }, "Naming session"],
    [{ action: "name" }, "Reviewing session title"],
    [{ action: "overview" }, "Reviewing session history"],
    [{ action: "read", entry_id: "entry" }, "Reviewing session history"],
    [{ action: "recovery" }, "Reviewing session history"],
    [{ action: "search", query: "secret" }, "Searching session history"],
  ])("caches session action %j without rendering raw payloads", (rawInput, action) => {
    const start = { sessionUpdate: "tool_call", toolCallId: "s", name: "session", title: "session", status: "in_progress", rawInput } as const;
    const cached = transcriptFromSessionUpdates([start]).items[0] as ToolItem;
    expect(cached.activityAction).toBe(action);
    const safe = { ...cached, get rawInput(): unknown { throw new Error("render parsed payload"); } };
    const live = { sessionId: "s", running: true, ready: true, historyLoading: false, draft: false, controlState: "idle", waitingForInput: false } as const;
    expect(composerActivity({ items: [safe] }, live)?.action).toBe(action);
  });

  it("caches at ingestion, retains on status updates, invalidates on argument or name updates, and renders without payload access", () => {
    const start = { sessionUpdate: "tool_call", toolCallId: "s", name: "shell", title: "shell", status: "in_progress", rawInput: { command: "npm test" } } as const;
    let state = applySessionUpdate({ items: [] }, start);
    expect((state.items[0] as ToolItem).activityAction).toBe("Running tests");
    state = applySessionUpdate(state, { sessionUpdate: "tool_call_update", toolCallId: "s", status: "pending" });
    const cached = state.items[0] as ToolItem;
    const safe = { ...cached, get rawInput(): unknown { throw new Error("render parsed payload"); } };
    const live = { sessionId: "s", running: true, ready: true, historyLoading: false, draft: false, controlState: "idle", waitingForInput: false } as const;
    expect(composerActivity({ items: [safe] }, live)?.action).toBe("Running tests");
    state = applySessionUpdate(state, { sessionUpdate: "tool_call_update", toolCallId: "s", rawInput: { command: "echo test" } });
    expect((state.items[0] as ToolItem).activityAction).toBeUndefined();
    state = applySessionUpdate(state, { sessionUpdate: "tool_call_update", toolCallId: "s", rawInput: { command: "npm run build" } });
    expect((state.items[0] as ToolItem).activityAction).toBe("Building project");
    state = applySessionUpdate(state, { sessionUpdate: "tool_call_update", toolCallId: "s", name: "read" });
    expect((state.items[0] as ToolItem).activityAction).toBeUndefined();
    expect((applySessionUpdates({ items: [] }, [start]).items[0] as ToolItem).activityAction).toBe("Running tests");
    expect((transcriptFromSessionUpdates([start]).items[0] as ToolItem).activityAction).toBe("Running tests");
  });
});
