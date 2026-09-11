import { describe, expect, it } from "vitest";
import type { CreateElicitationRequest } from "@agentclientprotocol/sdk";
import {
  canAcceptElicitationForSession,
  elicitationBelongsToActiveSession,
  elicitationSessionId,
  parseElicitation,
} from "./elicitation";

function request(property: Record<string, unknown>): CreateElicitationRequest {
  return {
    mode: "form",
    message: "Choose a value",
    requestedSchema: { type: "object", properties: { answer: property } },
  } as unknown as CreateElicitationRequest;
}

describe("parseElicitation", () => {
  it("parses a string field and preserves its metadata", () => {
    expect(parseElicitation(request({
      type: "string",
      title: "Answer",
      description: "A short response",
      default: "yes",
    }))).toEqual({
      key: "answer",
      label: "Answer",
      description: "A short response",
      type: "string",
      options: [],
      value: "yes",
    });
  });

  it("uses the first enum entry as a select default", () => {
    expect(parseElicitation(request({ type: "string", enum: ["one", "two"] }))).toEqual({
      key: "answer",
      label: "answer",
      type: "select",
      options: ["one", "two"],
      value: "one",
    });
  });

  it("parses boolean defaults", () => {
    expect(parseElicitation(request({ type: "boolean", default: true }))).toEqual({
      key: "answer",
      label: "answer",
      type: "boolean",
      options: [],
      value: true,
    });
  });

  it("rejects unsupported schemas", () => {
    expect(parseElicitation({ mode: "url" } as unknown as CreateElicitationRequest)).toBeNull();
    expect(parseElicitation(request({ type: "number" }))).toBeNull();
  });

  it("keeps session-scoped elicitation owned by the requesting session", () => {
    const scoped = {
      ...request({ type: "string" }),
      sessionId: "session-a",
    } as CreateElicitationRequest;

    expect(elicitationSessionId(scoped)).toBe("session-a");
    expect(elicitationBelongsToActiveSession("session-a", "session-a")).toBe(true);
    expect(elicitationBelongsToActiveSession("session-a", "session-b")).toBe(false);
    expect(elicitationBelongsToActiveSession(null, "session-b")).toBe(true);
  });

  it("allows independent pending elicitations in different sessions without making global UI concurrent", () => {
    const pending = new Set(["session-a"]);
    expect(canAcceptElicitationForSession("session-b", pending, false)).toBe(true);
    expect(canAcceptElicitationForSession("session-a", pending, false)).toBe(false);
    expect(canAcceptElicitationForSession(null, pending, false)).toBe(false);
    expect(canAcceptElicitationForSession(null, new Set(), false)).toBe(true);
    expect(canAcceptElicitationForSession("session-b", pending, true)).toBe(false);
  });
});
