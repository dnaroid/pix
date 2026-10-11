import { describe, expect, it, vi } from "vitest";
import type { AcpClient } from "../lib/acp-client";
import type { Attachment } from "../lib/attachments";
import type { MessageItem } from "../lib/transcript";
import { createActiveSessionState } from "./active-session-state.svelte";
import { createComposerMessageEdit } from "./composer-message-edit.svelte";

const image: Attachment = { id: "image", kind: "image", name: "pic.png", mimeType: "image/png", dataUrl: "data:image/png;base64,aGVsbG8=" };
const file: Attachment = { id: "file", kind: "file", name: "a.txt", mimeType: "text/plain", path: "/tmp/a.txt" };
const message: MessageItem = { type: "message", id: "replay-entry:user", sessionEntryId: "user", role: "user", text: "original", attachments: [image, file] };
function fixture() {
  const state = createActiveSessionState(); state.setSessionId("source");
  let key = "source"; let text = "previous draft"; let attachments: Attachment[] = [file]; let busy = false;
  const order: string[] = [];
  const resend = vi.fn(() => { order.push("send"); });
  const prepare = vi.fn(async (_sessionId: string, _edit: unknown) => { order.push("prepare"); return resend; });
  const rewind = vi.fn(async () => { order.push("rewind"); return { status: "ok" }; });
  const history = vi.fn(async () => { order.push("history"); return { updates: [], deferredToolCallIds: [] }; });
  const client = { userMessageAction: rewind, sessionHistory: history } as unknown as AcpClient;
  const reportError = vi.fn();
  const edit = createComposerMessageEdit({ client: () => client, state, draftKey: () => key,
    promptText: () => text, promptAttachments: () => attachments, setPromptText: (value) => { text = value; },
    setPromptAttachments: (value) => { attachments = value; }, invalidateAttachments: vi.fn(), busy: () => busy,
    setOperationRunning: (value) => { busy = value; }, prepare, markHistoryFullyLoaded: vi.fn(), focus: vi.fn(), reportError });
  return { edit, state, order, prepare, rewind, history, resend, reportError, get text() { return text; }, get attachments() { return attachments; },
    setText: (value: string) => { text = value; }, setAttachments: (value: Attachment[]) => { attachments = value; },
    switchSession: () => { state.setSessionId("other"); state.setTranscript({ items: [] }); key = "other"; text = "other draft"; attachments = []; },
    returnToSource: () => { state.setSessionId("source"); key = "source"; } };
}
describe("main composer edit and resend", () => {
  it("begin loads text and removable attachment clones without changing history", () => {
    const f = fixture(); const transcript = f.state.transcript;
    f.edit.begin("user", message);
    expect(f.edit.active).toBe(true); expect(f.text).toBe("original"); expect(f.attachments).toEqual([image, file]);
    expect(f.attachments[0]).not.toBe(image); expect(f.state.transcript).toBe(transcript); expect(f.order).toEqual([]);
    f.setAttachments([f.attachments[1]!]); f.setText("changed"); f.edit.cancel();
    expect(f.text).toBe("previous draft"); expect(f.attachments).toEqual([file]); expect(f.edit.active).toBe(false);
    expect(f.state.transcript).toBe(transcript); expect(f.order).toEqual([]);
  });
  it("ordinary Send prepares removed-attachment draft, rewinds then resends same session", async () => {
    const f = fixture(); f.edit.begin("user", message); f.setText("changed"); f.setAttachments([f.attachments[0]!]);
    expect(await f.edit.submit()).toBe(true);
    expect(f.prepare).toHaveBeenCalledWith("source", { text: "changed", attachments: [image] });
    expect(f.rewind).toHaveBeenCalledWith("source", "user", "rewind");
    expect(f.order).toEqual(["prepare", "rewind", "history", "send"]);
    expect(f.edit.active).toBe(false); expect(f.text).toBe(""); expect(f.attachments).toEqual([]);
  });
  it("no pending edit lets ordinary Send continue", async () => { expect(await fixture().edit.submit()).toBe(false); });
  it("closed tabs and disposed clients release pending edits", () => {
    const f = fixture(); f.edit.begin("user", message); f.edit.prune(null, ["source"]);
    expect(f.edit.active).toBe(false);
    f.edit.begin("user", message); f.edit.dispose(); expect(f.edit.active).toBe(false);
  });
  it("stale session during attachment preparation never rewinds or consumes new draft", async () => {
    const f = fixture(); f.edit.begin("user", message);
    f.prepare.mockImplementationOnce(async () => { f.switchSession(); return f.resend; });
    await f.edit.submit(); expect(f.rewind).not.toHaveBeenCalled(); expect(f.resend).not.toHaveBeenCalled();
    expect(f.text).toBe("other draft"); expect(f.edit.active).toBe(false);
  });
  it("failed preparation and changed draft leave edit pending without navigation", async () => {
    for (const failure of ["attachment", "draft"] as const) {
      const f = fixture(); f.edit.begin("user", message);
      f.prepare.mockImplementationOnce(async () => {
        if (failure === "attachment") throw new Error("unavailable image");
        f.setText("typed during preparation"); return f.resend;
      });
      await f.edit.submit(); expect(f.rewind).not.toHaveBeenCalled(); expect(f.edit.active).toBe(true);
      expect(f.reportError).toHaveBeenCalledOnce();
    }
  });
  it("branch changes and cancelled rewind never resend", async () => {
    const stale = fixture(); stale.edit.begin("user", message); stale.state.setTranscript({ ...stale.state.transcript });
    await stale.edit.submit(); expect(stale.rewind).not.toHaveBeenCalled(); expect(stale.reportError).toHaveBeenCalledOnce();
    const f = fixture(); f.edit.begin("user", message); f.rewind.mockResolvedValueOnce({ status: "cancelled" });
    await f.edit.submit(); expect(f.history).not.toHaveBeenCalled(); expect(f.resend).not.toHaveBeenCalled(); expect(f.edit.active).toBe(true);
  });
  it("duplicate Send is reserved and typing during navigation is not erased", async () => {
    const f = fixture(); f.edit.begin("user", message);
    let finish!: () => void;
    f.rewind.mockImplementationOnce(() => new Promise((resolve) => { finish = () => { f.setText("new typing"); resolve({ status: "ok" }); }; }));
    const first = f.edit.submit(); await vi.waitFor(() => expect(f.rewind).toHaveBeenCalledOnce());
    expect(await f.edit.submit()).toBe(true); finish(); await first;
    expect(f.resend).toHaveBeenCalledOnce(); expect(f.text).toBe("new typing"); expect(f.edit.active).toBe(false);
  });
  it("selection changes during committed rewind refresh only the source cache and consume its pending edit", async () => {
    const f = fixture(); f.edit.begin("user", message);
    f.rewind.mockImplementationOnce(async () => { f.switchSession(); return { status: "ok" }; });
    await f.edit.submit();
    expect(f.history).toHaveBeenCalledWith("source", true);
    expect(f.state.sessionTranscript("source")).toBeDefined();
    expect(f.state.sessionTranscript("source")).not.toBe(f.state.transcript);
    expect(f.resend).not.toHaveBeenCalled(); expect(f.text).toBe("other draft");
    f.returnToSource(); expect(f.edit.active).toBe(false);
  });
  it("failed refresh after committed rewind keeps edited text but exits edit mode", async () => {
    const f = fixture(); f.edit.begin("user", message); f.setText("keep this edit");
    f.history.mockRejectedValueOnce(new Error("history unavailable"));
    await f.edit.submit();
    expect(f.resend).not.toHaveBeenCalled(); expect(f.edit.active).toBe(false);
    expect(f.text).toBe("keep this edit"); expect(f.reportError).toHaveBeenCalledOnce();
    expect(await f.edit.submit()).toBe(false);
  });
});
