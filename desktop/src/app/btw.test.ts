import { describe, it, expect, vi } from "vitest";
import { createBtwStore } from "./btw.svelte";
import { btwDiscussionDraft, canInsertBtwDraft } from "./btw-draft";
import type { BtwCommand, BtwEvent, BtwState } from "../../../acp/src/btw/contract";
import { clampBtwPaneWidth, btwPaneWidthFromKeyboard } from "../lib/btw-pane-resize";

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((ok) => { resolve = ok; }); return { promise, resolve }; }
async function flush() { for (let i = 0; i < 10; i++) await Promise.resolve(); }
function setup() {
  let ready = true;
  const states = new Map<string, BtwState>();
  const backendState = (id: string): BtwState => states.get(id) ?? { runtimeId: `r-${id}`, contextKey: `k-${id}`, busyRequestId: null };
  const command = vi.fn(async (id: string, value: BtwCommand) => {
    const result = backendState(id);
    if (value.action === "ask") return { ...result, busyRequestId: value.requestId };
    return result;
  });
  const store = createBtwStore({ command, runtimeReady: () => ready });
  const latestAsk = () => [...command.mock.calls].reverse().find(([, c]) => c.action === "ask")?.[1] as Extract<BtwCommand, { action: "ask" }>;
  const push = (overrides: Partial<BtwEvent> = {}, id = "a") => {
    const ask = latestAsk();
    store.handleSessionState({ sessionId: id, channel: "btw", data: { version: 1, runtimeId: backendState(id).runtimeId,
      requestId: ask.requestId, sequence: 1, phase: "done", text: "Answer", busyRequestId: null, ...overrides } });
  };
  return { store, command, push, latestAsk, states, backendState, ready: (value: boolean) => { ready = value; } };
}

describe("temporary BTW state", () => {
  it("keeps model/effort choices local and snapshots them before async preparation", async () => {
    const h = setup(); await h.store.open("a"); await h.store.open("b");
    h.store.setModelThinking("a", "fixture/fast", "high");
    const read = deferred<BtwState>();
    h.command.mockImplementationOnce(() => read.promise);
    h.store.setDraft("a", "Question");
    const sending = h.store.send("a");
    h.store.setModelThinking("a", "fixture/other", "off");
    read.resolve(h.backendState("a")); await sending;
    expect(h.latestAsk()).toMatchObject({ modelRef: "fixture/fast", thinkingLevel: "high" });
    h.push({ modelRef: "fixture/fast", thinkingLevel: "high" });
    expect(h.store.state("a")).toMatchObject({ modelRef: "fixture/other", thinkingLevel: "off", actualModelRef: "fixture/fast", actualThinkingLevel: "high" });
    expect(h.store.state("b")).toMatchObject({ modelRef: null, thinkingLevel: null, thinkingByModel: {} });
    await h.store.send("a", "Next question");
    expect(h.latestAsk()).toMatchObject({ modelRef: "fixture/other", thinkingLevel: "off" }); h.push();
    expect(h.store.state("a")?.thinkingByModel).toEqual({ "fixture/fast": "high", "fixture/other": "off" });
    h.store.hide("a"); await h.store.open("a");
    expect(h.store.state("a")?.thinkingLevel).toBe("off");
    h.store.setModelThinking("a", null, null);
    await h.store.send("a", "Use parent pair");
    expect(h.latestAsk()).not.toHaveProperty("modelRef");
    expect(h.latestAsk()).not.toHaveProperty("thinkingLevel"); h.push();
    h.store.clearSession("a"); await h.store.open("a");
    expect(h.store.state("a")).toMatchObject({ modelRef: null, thinkingLevel: null, thinkingByModel: {} });
    expect(h.command.mock.calls.every(([, command]) => ["state", "ask", "cancel"].includes(command.action))).toBe(true);
    h.store.reset();
  });

  it("rejects invalid local effort atomically and bounds per-model memory", async () => {
    const h = setup(); await h.store.open("a");
    h.store.setModelThinking("a", "fixture/first", "low");
    expect(() => h.store.setModelThinking("a", "fixture/other", "invalid")).toThrow(/thinking level/);
    expect(h.store.state("a")).toMatchObject({ modelRef: "fixture/first", thinkingLevel: "low" });
    for (let i = 0; i < 90; i++) h.store.setModelThinking("a", `fixture/${i}`, "high");
    expect(Object.keys(h.store.state("a")!.thinkingByModel)).toHaveLength(64);
    h.store.reset();
  });
  it("opens without inference and preserves history/draft on hide but not close/reset", async () => {
    const h = setup(); await h.store.open("a");
    expect(h.command).toHaveBeenCalledWith("a", { action: "state" });
    h.store.setDraft("a", "Question"); await h.store.send("a"); h.push();
    h.store.setDraft("a", "Follow-up draft"); h.store.hide("a");
    expect(h.store.state("a")?.hidden).toBe(true);
    await h.store.open("a");
    expect(h.store.state("a")?.history.map((m) => m.text)).toEqual(["Question", "Answer"]);
    expect(h.store.state("a")?.draft).toBe("Follow-up draft");
    h.store.clearSession("a"); h.push({ sequence: 100 });
    expect(h.store.state("a")).toBeUndefined();
    await h.store.open("a"); expect(h.store.state("a")?.history).toEqual([]);
    h.store.reset(); expect(h.store.state("a")).toBeUndefined();
  });

  it("does not mix sessions and carries complete prior side exchanges into follow-up", async () => {
    const h = setup(); await h.store.open("a"); h.store.setDraft("a", "Why?");
    await h.store.send("a"); const a = h.latestAsk(); await h.store.open("b");
    h.push({ requestId: a.requestId }, "a");
    expect(h.store.state("b")?.history).toEqual([]);
    expect(h.store.state("a")?.history).toHaveLength(2);
    h.store.setDraft("a", "Explain with an example"); await h.store.send("a");
    expect(h.latestAsk().history).toEqual([{ role: "user", text: "Why?" }, { role: "assistant", text: "Answer" }]);
    h.store.reset();
  });

  it("late acknowledgement cannot resurrect an already finished request", async () => {
    const h = setup(); await h.store.open("a");
    const accepted = deferred<BtwState>();
    h.command.mockImplementation(async (id, command) => command.action === "ask" ? accepted.promise : h.backendState(id));
    h.store.setDraft("a", "Question"); const pending = h.store.send("a"); await flush();
    const ask = h.latestAsk(); h.push({ text: "Fast result" });
    accepted.resolve({ ...h.backendState("a"), busyRequestId: ask.requestId }); await pending;
    expect(h.store.state("a")?.busyRequestId).toBeNull();
    expect(h.store.state("a")?.phase).toBe("done");
    expect(h.store.state("a")?.history.at(-1)?.text).toBe("Fast result");
    expect(h.store.state("a")?.draft).toBe(""); h.store.reset();
  });

  it("Stop retains physical lock and ignores late text without stopping a parent", async () => {
    const h = setup(); await h.store.open("a"); h.store.setDraft("a", "Question"); await h.store.send("a");
    const ask = h.latestAsk();
    h.states.set("a", { ...h.backendState("a"), busyRequestId: ask.requestId });
    await h.store.stop("a");
    expect(h.store.state("a")?.busyRequestId).toBe(ask.requestId);
    h.push({ phase: "streaming", text: "SHOULD_NOT_SHOW", busyRequestId: ask.requestId, sequence: 10 });
    expect(h.store.state("a")?.answer).toBe("");
    expect(h.store.state("a")?.history).toEqual([]);
    h.push({ phase: "cancelled", busyRequestId: null, sequence: 11 });
    expect(h.store.state("a")?.busyRequestId).toBeNull();
    expect(h.command.mock.calls.every(([, c]) => ["state", "ask", "cancel"].includes(c.action))).toBe(true); h.store.reset();
  });

  it("reset invalidates a still-opening pane even when no session state exists yet", async () => {
    const h = setup(); const response = deferred<BtwState>();
    h.command.mockImplementationOnce(() => response.promise);
    const open = h.store.open("a"); h.store.reset(); response.resolve(h.backendState("a")); await open;
    expect(h.store.state("a")).toBeUndefined();
  });

  it("a new conversation cancels preparing requests and cannot revive old completions", async () => {
    const h = setup(); await h.store.open("a"); h.store.setDraft("a", "Question");
    const state = deferred<BtwState>(); h.command.mockImplementationOnce(() => state.promise);
    const sending = h.store.send("a"); h.store.newConversation("a");
    state.resolve(h.backendState("a")); await sending;
    expect(h.command.mock.calls.filter(([, c]) => c.action === "ask")).toHaveLength(0);
    expect(h.store.state("a")?.draft).toBe("");
    h.store.setDraft("a", "Next"); await h.store.send("a"); const old = h.latestAsk();
    h.store.newConversation("a"); h.push({ requestId: old.requestId });
    expect(h.store.state("a")?.history).toEqual([]); h.store.reset();
  });

  it("runtime replacement clears side memory instead of silently sending on a replacement", async () => {
    const h = setup(); await h.store.open("a"); h.store.setDraft("a", "Sensitive draft");
    h.states.set("a", { runtimeId: "new", contextKey: "new", busyRequestId: null });
    await h.store.send("a");
    expect(h.command.mock.calls.filter(([, c]) => c.action === "ask")).toHaveLength(0);
    expect(h.store.state("a")?.draft).toBe("");
    expect(h.store.state("a")?.runtimeId).toBe("new"); h.store.reset();
  });

  it("branch changes clear stale history before the next question", async () => {
    const h = setup(); await h.store.open("a"); h.store.setDraft("a", "Old"); await h.store.send("a"); h.push();
    h.states.set("a", { ...h.backendState("a"), contextKey: "different-branch" });
    h.store.setDraft("a", "New"); await h.store.send("a");
    expect(h.latestAsk().history).toEqual([]);
    expect(h.store.state("a")?.historyReset).toBe(true); h.store.reset();
  });

  it("out-of-order progress and old runtime events are ignored", async () => {
    const h = setup(); await h.store.open("a"); h.store.setDraft("a", "Q"); await h.store.send("a");
    const request = h.latestAsk().requestId;
    h.push({ phase: "streaming", sequence: 5, text: "new", busyRequestId: request });
    h.push({ phase: "streaming", sequence: 2, text: "old", busyRequestId: request });
    h.push({ runtimeId: "old", phase: "done", sequence: 6, text: "wrong" });
    expect(h.store.state("a")?.answer).toBe("new"); h.store.reset();
  });

  it("the largest current exchange remains visible rather than disappearing under the history limit", async () => {
    const h = setup(); await h.store.open("a"); h.store.setDraft("a", "Q".repeat(8_000));
    for (let index = 0; index < 4; index++) h.store.addExcerpt("a", { label: "file", text: "E".repeat(8_000) });
    await h.store.send("a"); h.push({ text: "A".repeat(32_000) });
    expect(h.store.state("a")?.history).toHaveLength(2);
    expect(h.store.state("a")?.history.at(-1)?.text).toHaveLength(32_000);
    expect(h.store.state("a")?.historyClipped).toBe(true);
    expect(h.store.state("a")?.history.reduce((sum, message) => sum + message.text.length, 0)).toBeLessThanOrEqual(48_000);
    h.store.reset();
  });

  it("send acknowledgement does not overwrite a new draft or excerpts typed during request acceptance", async () => {
    const h = setup(); await h.store.open("a"); const ack = deferred<BtwState>();
    h.command.mockImplementation(async (id, command) => command.action === "ask" ? ack.promise : h.backendState(id));
    h.store.setDraft("a", "First"); const pending = h.store.send("a"); await flush();
    h.store.setDraft("a", "Second"); h.store.addExcerpt("a", { label: "new", text: "Keep" });
    ack.resolve({ ...h.backendState("a"), busyRequestId: h.latestAsk().requestId }); await pending;
    expect(h.store.state("a")?.draft).toBe("Second"); expect(h.store.state("a")?.excerpts).toHaveLength(1); h.store.reset();
  });

  it("scroll memory is session/runtime scoped and released with the side chat", async () => {
    const h = setup(); await h.store.open("a"); h.store.setScroll("a", "r-a", 120);
    h.store.setScroll("a", "retired", 400); expect(h.store.state("a")?.scrollTop).toBe(120);
    h.store.clearSession("a"); await h.store.open("a"); expect(h.store.state("a")?.scrollTop).toBe(0); h.store.reset();
  });
});

describe("BTW explicit parent draft and resizing", () => {
  it("does not replace existing draft, attachments, another session or a question form", () => {
    expect(canInsertBtwDraft("a", "a", true, false, "", [])).toBe(true);
    for (const args of [["a", "b", true, false, "", []], ["a", "a", false, false, "", []],
      ["a", "a", true, true, "", []], ["a", "a", true, false, " ", []], ["a", "a", true, false, "", [{}]]] as const) {
      const [owner, active, ready, blocked, draft, attachments] = args;
      expect(canInsertBtwDraft(owner, active, ready, blocked, draft, attachments)).toBe(false);
    }
    const draft = btwDiscussionDraft("/delete\n@src/file\n[Image #4]");
    expect(draft.startsWith("/")).toBe(false); expect(draft).not.toContain("@src/"); expect(draft).not.toContain("[Image");
  });
  it("bounds the pane against the actual workbench and keeps a usable parent region", () => {
    expect(clampBtwPaneWidth(900, 1_200)).toBe(640);
    expect(clampBtwPaneWidth(380, 480)).toBeLessThanOrEqual(300);
    expect(btwPaneWidthFromKeyboard(380, "ArrowLeft", 1_200)).toBeGreaterThan(380);
    expect(btwPaneWidthFromKeyboard(380, "ArrowRight", 1_200)).toBeLessThan(380);
  });
});
