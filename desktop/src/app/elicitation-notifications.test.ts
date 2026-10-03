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
  function questionRequest(): CreateElicitationRequest {
    return { mode: "_pix.question", sessionId: "session-1", message: "Which scope?",
      version: 1, questions: [{ id: "scope", label: "Scope", prompt: "Which scope?", choices: [
        { value: "small", label: "Small" }, { value: "large", label: "Large" },
      ] }],
    } as unknown as CreateElicitationRequest;
  }

  it.each(["cancelAll", "cancelForSession"] as const)("marks question %s as interruption but clears its local state", async (method) => {
    const store = createElicitationStore({ cancelQuestionImageOperation: vi.fn(), activeSessionId: () => "session-1" });
    const response = store.request(questionRequest());
    expect(store.pendingBySession.get("session-1")?.kind).toBe("question");
    if (method === "cancelAll") store.cancelAll();
    else store.cancelForSession("session-1");
    await expect(response).resolves.toEqual({ action: "cancel", _meta: { "_pix/question-interrupted": true } });
    expect(store.pendingBySession.size).toBe(0);
  });

  it("keeps explicit question Cancel distinct from interruption", async () => {
    const store = createElicitationStore({ cancelQuestionImageOperation: vi.fn(), activeSessionId: () => "session-1" });
    const response = store.request(questionRequest());
    const pending = store.pendingBySession.get("session-1");
    if (pending?.kind !== "question") throw new Error("Expected questionnaire");
    store.cancel(pending.requestId);
    await expect(response).resolves.toEqual({ action: "cancel" });
  });

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
