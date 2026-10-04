import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AcpClient } from "../lib/acp-client";
import type { Attachment } from "../lib/attachments";
import type { HeadsUpSnapshot } from "../lib/heads-up";
import { createHeadsUpStore } from "./heads-up.svelte";

function snapshot(overrides: Partial<HeadsUpSnapshot> = {}): HeadsUpSnapshot {
  return { version: 1, instanceId: "runtime-a", revision: 1, enabled: true, model: "openai-codex/gpt-6-luna", phase: "idle", checks: 1, inputTokens: 10, outputTokens: 3,
    notice: { id: "note-a", title: "Compatibility changed", consequence: "Old configs fail", createdAt: 1000, expiresAt: 31000, evidence: [{ id: "entry-a", text: "Loader rejects old format" }] }, ...overrides };
}
function deferred() { let resolve!: () => void; const promise = new Promise<void>((ok) => { resolve = ok; }); return { promise, resolve }; }
function setup() {
  const prompt = vi.fn(async (..._args: unknown[]) => {}); const reportError = vi.fn();
  const client = { prompt } as unknown as AcpClient;
  const store = createHeadsUpStore({ client: () => client, runtimeReady: () => true, reportError });
  const push = (value = snapshot(), sessionId = "s1") => store.handleSessionState({ sessionId, channel: "heads-up", data: value });
  return { store, push, prompt, reportError };
}
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(1000); });
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

describe("Heads up session mirror", () => {
  it("isolates sessions and rejects old revisions and retired runtime instances", () => {
    const h = setup(); h.push(); expect(h.store.notice("s2")).toBeUndefined();
    h.push(snapshot({ revision: 0, notice: null })); expect(h.store.notice("s1")).toBeDefined();
    h.push(snapshot({ instanceId: "runtime-b", revision: 1, notice: null }));
    h.push(snapshot({ revision: 999 })); expect(h.store.state("s1")?.instanceId).toBe("runtime-b");
    h.store.clearSession("s1"); h.push(snapshot({ instanceId: "runtime-b", revision: 2 })); expect(h.store.state("s1")).toBeUndefined();
    h.store.reset(); expect(vi.getTimerCount()).toBe(0);
  });
  it("expires a notice while idle and does not show an already expired push", () => {
    const h = setup(); h.push(); expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(30000); expect(h.store.notice("s1")).toBeUndefined(); expect(vi.getTimerCount()).toBe(0);
    h.push(snapshot({ revision: 2 })); expect(h.store.notice("s1")).toBeUndefined(); h.store.reset();
  });
  it("immediately removes unconfirmed claims and actions, then accepts a fresh retained identity", async () => {
    const h = setup(); h.push(); const original = h.store.notice("s1")!;
    h.push(snapshot({ revision: 2, notice: null, notices: [], awaitingReview: true }));
    expect(h.store.notice("s1")).toBeUndefined();
    expect(h.store.state("s1")?.notice).toBeNull();
    expect(h.store.state("s1")?.awaitingReview).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    await h.store.sendFeedback("s1", "dismiss", original.id);
    expect(h.store.discuss("s1", original, () => true, () => "", () => [], () => {})).toBe(false);
    expect(h.prompt).not.toHaveBeenCalled();
    h.push(snapshot()); expect(h.store.notice("s1")).toBeUndefined();
    h.push(snapshot({ revision: 3, notice: original, notices: [original], awaitingReview: false }));
    expect(h.store.notice("s1")).toEqual(original);
    vi.advanceTimersByTime(30000); expect(h.store.notice("s1")).toBeUndefined();
    h.store.reset();
  });
  it("keeps selection across snapshots, chooses the next surviving card, and expires cards independently", () => {
    const h = setup();
    const a = snapshot().notice!;
    const b = { ...a, id: "note-b", title: "B", expiresAt: 11000 };
    const c = { ...a, id: "note-c", title: "C", expiresAt: 21000 };
    h.push(snapshot({ notice: a, notices: [a, b, c] }));
    h.store.selectNotice("s1", "note-a", 1);
    expect(h.store.notice("s1")?.id).toBe("note-b");
    h.push(snapshot({ revision: 2, notice: a, notices: [a, b, c] }));
    expect(h.store.notice("s1")?.id).toBe("note-b");
    vi.advanceTimersByTime(10000);
    expect(h.store.notice("s1")?.id).toBe("note-c");
    h.push(snapshot({ revision: 3, notice: a, notices: [a, c] }));
    expect(h.store.notice("s1")?.id).toBe("note-c");
    h.store.reset();
  });
  it("selects the next surviving stack member if the selected card is removed", () => {
    const h = setup();
    const a = snapshot().notice!;
    const b = { ...a, id: "note-b" };
    const c = { ...a, id: "note-c" };
    h.push(snapshot({ notices: [a, b, c] }));
    h.store.selectNotice("s1", "note-a", 1);
    h.push(snapshot({ revision: 2, notice: a, notices: [a, c] }));
    expect(h.store.notice("s1")?.id).toBe("note-c");
    h.store.reset();
  });
  it("removal of the last selected card falls back to the last survivor, not the first", () => {
    const h = setup(); const a = snapshot().notice!;
    const b = { ...a, id: "note-b" }; const c = { ...a, id: "note-c" };
    h.push(snapshot({ notices: [a, b, c] })); h.store.selectNotice("s1", a.id, -1);
    h.push(snapshot({ revision: 2, notices: [a, b] }));
    expect(h.store.notice("s1")?.id).toBe(b.id); h.store.reset();
  });
  it("an already expired selected push falls back to an actionable live card and accurate status", async () => {
    const h = setup(); const a = snapshot().notice!; const b = { ...a, id: "note-b", expiresAt: 61_000 };
    vi.setSystemTime(32_000); h.push(snapshot({ notices: [a, b] }));
    expect(h.store.notice("s1")?.id).toBe(b.id); expect(h.store.state("s1")?.notice?.id).toBe(b.id);
    await h.store.sendFeedback("s1", "dismiss", b.id);
    expect(h.prompt).toHaveBeenCalledWith("s1", [{ type: "text", text: `/heads-up dismiss ${b.id}` }]);
    h.store.reset();
  });
  it("sends scoped feedback IDs but never clears a newer notice from a late reply", async () => {
    const h = setup(); const wait = deferred(); h.prompt.mockImplementationOnce(() => wait.promise); h.push();
    const command = h.store.sendFeedback("s1", "dismiss", "note-a");
    expect(h.prompt).toHaveBeenCalledWith("s1", [{ type: "text", text: "/heads-up dismiss note-a" }]);
    h.push(snapshot({ revision: 2, notice: { ...snapshot().notice!, id: "note-b" } })); wait.resolve(); await command;
    expect(h.store.notice("s1")?.id).toBe("note-b"); h.store.reset();
  });
  it("allows off during pending check and old finally cannot remove newer pending command", async () => {
    const h = setup(); h.push(); const first = deferred(); const second = deferred();
    h.prompt.mockImplementationOnce(() => first.promise);
    const check = h.store.sendControl("s1", "check"); await h.store.sendControl("s1", "off");
    expect(h.prompt).toHaveBeenCalledTimes(2);
    h.store.reset(); h.push(snapshot({ instanceId: "runtime-b" })); h.prompt.mockImplementationOnce(() => second.promise);
    const newCheck = h.store.sendControl("s1", "check"); first.resolve(); await check;
    expect(h.store.isPending("s1", "/heads-up check")).toBe(true);
    second.resolve(); await newCheck; expect(h.store.isPending("s1", "/heads-up check")).toBe(false); h.store.reset();
  });
  it("draft insertion checks live owner/dialog, expiry, exact empty text and attachments; never submits", () => {
    const h = setup(); h.push(); const note = h.store.notice("s1")!;
    let text = ""; let attachments: Attachment[] = []; let owned = true;
    const insert = () => h.store.discuss("s1", note, () => owned, () => text, () => attachments, (value) => { text = value; });
    attachments = [{} as Attachment]; expect(insert()).toBe(false); expect(attachments).toHaveLength(1);
    attachments = []; text = " "; expect(insert()).toBe(false); expect(text).toBe(" ");
    text = ""; owned = false; expect(insert()).toBe(false); owned = true; expect(insert()).toBe(true);
    expect(text).toContain("Please check this observer note"); expect(h.prompt).not.toHaveBeenCalled();
    text = ""; vi.advanceTimersByTime(30000); expect(insert()).toBe(false); h.store.reset();
  });
  it("rejects stale feedback before making a command", async () => {
    const h = setup(); h.push(); await h.store.sendFeedback("s1", "known", "other-note"); expect(h.prompt).not.toHaveBeenCalled(); h.store.reset();
  });
  it("rejects callbacks from a retired runtime even when its notice ID is reused", async () => {
    const h = setup(); h.push(snapshot({ notices: [snapshot().notice!] }));
    const original = h.store.notice("s1")!;
    h.push(snapshot({ instanceId: "runtime-b", revision: 1, notices: [original] }));
    await h.store.sendFeedback("s1", "dismiss", original.id, "runtime-a");
    let text = "";
    expect(h.store.discuss("s1", original, () => true, () => text, () => [], (value) => { text = value; }, "runtime-a")).toBe(false);
    expect(h.prompt).not.toHaveBeenCalled();
    expect(text).toBe(""); h.store.reset();
  });
  it("rejects actions captured for a card after another card becomes selected", async () => {
    const h = setup();
    const a = snapshot().notice!;
    const b = { ...a, id: "note-b", title: "B" };
    h.push(snapshot({ notices: [a, b] }));
    h.store.selectNotice("s1", a.id, 1);
    h.store.selectNotice("s1", a.id, 1);
    expect(h.store.notice("s1")?.id).toBe(b.id);
    await h.store.sendFeedback("s1", "dismiss", a.id, "runtime-a");
    let text = "";
    expect(h.store.discuss("s1", a, () => true, () => text, () => [], (value) => { text = value; }, "runtime-a")).toBe(false);
    expect(h.prompt).not.toHaveBeenCalled();
    expect(h.store.discuss("s1", b, () => true, () => text, () => [], (value) => { text = value; }, "runtime-a")).toBe(true);
    h.store.reset();
  });
});
