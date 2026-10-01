import { describe, expect, it, vi } from "vitest";
import { createTranscriptUserMessageMenuController } from "./transcript-user-message-menu-controller.svelte";
import type { MessageItem } from "../lib/transcript";

function fixture() {
  const message: MessageItem = { type: "message", id: "user", role: "user", text: "prompt", attachments: [] };
  const options = {
    items: () => [message], activeSessionId: (): string | null => "source",
    promptRunning: () => true, operationRunning: () => false, historyLoading: () => false,
    onScroll: vi.fn(), onAction: vi.fn(),
  };
  return { message, options, controller: createTranscriptUserMessageMenuController(options) };
}

describe("running-session user-message actions", () => {
  it("allows only copy and fork in new tab while running", async () => {
    const f = fixture();
    expect(f.controller.canMutate).toBe(false);
    expect(f.controller.canForkNewTab).toBe(true);
    for (const action of ["fork", "undo", "fork-new-tab", "copy"] as const) {
      await f.controller.runAction(f.message, action);
    }
    expect(f.options.onAction.mock.calls.map((call) => call[1])).toEqual(["fork-new-tab", "copy"]);
    f.controller.dispose();
  });

  it.each(["operationRunning", "historyLoading"] as const)("blocks new-tab fork during %s", async (gate) => {
    const f = fixture();
    f.options[gate] = () => true;
    expect(f.controller.canForkNewTab).toBe(false);
    await f.controller.runAction(f.message, "fork-new-tab");
    expect(f.options.onAction).not.toHaveBeenCalled();
  });

  it("blocks renderer-only rows and missing sessions", async () => {
    const f = fixture();
    await f.controller.runAction({ ...f.message, localOnly: true }, "fork-new-tab");
    f.options.activeSessionId = () => null;
    await f.controller.runAction(f.message, "fork-new-tab");
    expect(f.options.onAction).not.toHaveBeenCalled();
  });
});
