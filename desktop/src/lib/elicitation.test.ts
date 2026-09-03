import { describe, expect, it } from "vitest";
import type { CreateElicitationRequest } from "@agentclientprotocol/sdk";
import { parseElicitation } from "./elicitation";

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
});
