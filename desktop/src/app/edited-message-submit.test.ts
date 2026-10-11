import { describe, expect, it, vi } from "vitest";
import type { AcpClient } from "../lib/acp-client";
import { createEditedMessageSubmit } from "./edited-message-submit";

function fixture() {
  let sessionId: string | null = "session";
  const client = { sessionImage: vi.fn(async () => ({ mimeType: "image/png", data: "aGVsbG8=" })) };
  const append = vi.fn(() => vi.fn());
  const run = vi.fn(async () => undefined);
  const prepare = createEditedMessageSubmit({
    client: () => client as unknown as AcpClient, sessionId: () => sessionId,
    prompts: { hasPromptRun: () => false, isRunning: () => false, runPromptRequest: run },
    imagePromptSupported: () => true, nextLocalMessageId: () => "optimistic-edit", appendUserMessage: append,
    scrollToLatest: vi.fn(async () => undefined), refreshSessions: vi.fn(), reportError: vi.fn(),
  });
  return { prepare, client, append, run, changeSession: () => { sessionId = "other"; } };
}

describe("edited message submission", () => {
  it("resolves replay images before rewind/commit and sends retained attachments", async () => {
    const f = fixture();
    const send = await f.prepare("session", { text: "edited", attachments: [{ id: "image", name: "Original", kind: "image", mimeType: "image/png", deferredImageId: "user:image:0" }] });
    expect(f.client.sessionImage).toHaveBeenCalledWith("session", "user:image:0");
    expect(f.append).not.toHaveBeenCalled(); expect(f.run).not.toHaveBeenCalled();
    send();
    expect(f.append).toHaveBeenCalledWith("edited", "optimistic-edit", [expect.objectContaining({ dataUrl: "data:image/png;base64,aGVsbG8=" })]);
    expect(f.run).toHaveBeenCalledWith(f.client, "session", [
      { type: "text", text: "edited" },
      { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
    ], [], "optimistic-edit");
  });

  it("does not submit to a different session after async preparation", async () => {
    const f = fixture(); const send = await f.prepare("session", { text: "edited", attachments: [] });
    f.changeSession(); expect(send).toThrow(/conversation changed/); expect(f.run).not.toHaveBeenCalled();
  });

  it("fails preparation without touching the history when a deferred image is unavailable", async () => {
    const f = fixture(); f.client.sessionImage.mockRejectedValueOnce(new Error("image unavailable"));
    await expect(f.prepare("session", { text: "edited", attachments: [{ id: "image", name: "Original", kind: "image", mimeType: "image/png", deferredImageId: "image" }] })).rejects.toThrow("image unavailable");
    expect(f.append).not.toHaveBeenCalled(); expect(f.run).not.toHaveBeenCalled();
  });
});
