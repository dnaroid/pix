import { describe, expect, it, vi } from "vitest";
import type { CreateElicitationRequest } from "@agentclientprotocol/sdk";
import { createElicitationStore } from "./elicitation.svelte";

function formRequest(sessionId = "session-1"): CreateElicitationRequest {
  return {
    mode: "form",
    sessionId,
    message: "Choose a value",
    requestedSchema: {
      type: "object",
      properties: { value: { type: "string", title: "Value" } },
      required: ["value"],
    },
  } as unknown as CreateElicitationRequest;
}

describe("elicitation notification ownership", () => {
  it("announces accepted agent elicitations but not Desktop-local text input", async () => {
    const onPendingCreated = vi.fn();
    const store = createElicitationStore({
      cancelQuestionImageOperation: vi.fn(),
      activeSessionId: () => "session-1",
      onPendingCreated,
    });

    const agentRequest = store.request(formRequest());
    expect(onPendingCreated).toHaveBeenCalledTimes(1);
    store.cancelAll();
    await expect(agentRequest).resolves.toEqual({ action: "cancel" });

    const localRequest = store.requestLocalTextInput("Name the fork", "Name");
    expect(onPendingCreated).toHaveBeenCalledTimes(1);
    const pending = store.pendingBySession.get("session-1") ?? null;
    store.updateFormValue(pending, "fork-name");
    store.answerForm(store.pendingBySession.get("session-1") ?? null, true);
    await expect(localRequest).resolves.toBe("fork-name");
    expect(onPendingCreated).toHaveBeenCalledTimes(1);
  });
});
