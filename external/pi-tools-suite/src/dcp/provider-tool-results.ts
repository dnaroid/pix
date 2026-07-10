import { createHash } from "node:crypto";
import type { ToolRecord } from "./state.js";

export interface ProviderToolResultEvidence {
  ids: Set<string>;
  anonymousSignatures: Set<string>;
}

function responseText(response: unknown): string | undefined {
  if (typeof response === "string") return response;
  if (!response || typeof response !== "object") return undefined;
  const record = response as Record<string, unknown>;
  if (typeof record.output === "string") return record.output;
  if (typeof record.error === "string") return record.error;
  return undefined;
}

function signature(toolName: string, outputText: string): string {
  return createHash("sha256")
    .update(toolName)
    .update("\u0000")
    .update(outputText)
    .digest("hex");
}

/** Collect only tool-result evidence, never assistant tool-call IDs. */
export function collectProviderToolResultEvidence(payload: unknown): ProviderToolResultEvidence {
  const evidence: ProviderToolResultEvidence = {
    ids: new Set<string>(),
    anonymousSignatures: new Set<string>(),
  };
  const visited = new Set<object>();

  function visit(value: unknown): void {
    if (!value || typeof value !== "object") return;
    if (visited.has(value)) return;
    visited.add(value);

    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }

    const record = value as Record<string, unknown>;
    if (record.role === "toolResult" && typeof record.toolCallId === "string") {
      evidence.ids.add(record.toolCallId);
    }
    if (record.role === "tool" && typeof record.tool_call_id === "string") {
      evidence.ids.add(record.tool_call_id);
    }
    if (record.type === "function_call_output" && typeof record.call_id === "string") {
      evidence.ids.add(record.call_id);
    }
    if (record.type === "tool_result" && typeof record.tool_use_id === "string") {
      evidence.ids.add(record.tool_use_id);
    }

    const functionResponse = record.functionResponse;
    if (functionResponse && typeof functionResponse === "object") {
      const responseRecord = functionResponse as Record<string, unknown>;
      if (typeof responseRecord.id === "string") evidence.ids.add(responseRecord.id);
      const outputText = responseText(responseRecord.response);
      if (typeof responseRecord.name === "string" && outputText !== undefined) {
        evidence.anonymousSignatures.add(signature(responseRecord.name, outputText));
      }
    }

    for (const nested of Object.values(record)) visit(nested);
  }

  visit(payload);
  return evidence;
}

export function providerPayloadIncludesToolResult(
  evidence: ProviderToolResultEvidence,
  record: ToolRecord,
): boolean {
  if (evidence.ids.has(record.toolCallId)) return true;
  for (const id of evidence.ids) {
    if (record.toolCallId.startsWith(`${id}|`)) return true;
  }
  return typeof record.outputText === "string" &&
    evidence.anonymousSignatures.has(signature(record.toolName, record.outputText));
}
