import { createHash } from "node:crypto";
import type { ToolRecord } from "./state.js";
import { stripStaleDcpMetadataLines } from "./pruner-metadata.js";

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
    .update(stripStaleDcpMetadataLines(outputText))
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

export function providerPayloadRevision(payload: unknown): string | undefined {
  try {
    const serialized = JSON.stringify(payload);
    if (serialized === undefined) return undefined;
    return createHash("sha256").update(serialized).digest("hex");
  } catch {
    return undefined;
  }
}

export interface ProviderEvidenceAttempt {
  sessionEpoch: number;
  provider?: string;
  model?: string;
  contentRevision?: string;
  statePath?: string;
  sessionId?: string;
  toolIds: ReadonlySet<string>;
  opportunityAvailable?: boolean;
}

export interface ProviderEvidenceFinalMessage {
  sessionEpoch: number;
  provider?: string;
  model?: string;
  stopReason?: string;
}

export interface ProviderEvidencePendingSnapshot {
  firstAttemptId: number;
  lastAttemptId: number;
  attempts: number;
  sessionEpoch: number;
  provider?: string;
  model?: string;
  contentRevision?: string;
  statePath?: string;
  sessionId?: string;
  toolIds: Set<string>;
  opportunityAvailable: boolean;
  ambiguous: boolean;
}

export type ProviderEvidenceCompletion =
  | {
      status: "promote";
      firstAttemptId: number;
      lastAttemptId: number;
      attempts: number;
      sessionEpoch: number;
      statePath?: string;
      sessionId?: string;
      toolIds: Set<string>;
      opportunityAvailable: boolean;
    }
  | {
      status: "refused";
      reason:
        | "no-pending"
        | "terminal-failure"
        | "ambiguous"
        | "missing-identity"
        | "stale-session"
        | "identity-mismatch";
      attempts: number;
    };

function sameStringSet(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  if (left.size !== right.size) return false;
  for (const value of left) {
    if (!right.has(value)) return false;
  }
  return true;
}

function attemptHasIdentity(attempt: ProviderEvidenceAttempt): boolean {
  return Boolean(attempt.provider && attempt.model && attempt.contentRevision);
}

/**
 * Correlates provider-input evidence with one finalized assistant message without
 * inventing a request ID the extension API does not expose. Repeated identical
 * attempts are treated as retries; any changed model/content/owner while an
 * attempt is pending makes the evidence ambiguous and therefore non-promotable.
 */
export class ProviderEvidenceTracker {
  private pending: ProviderEvidencePendingSnapshot | undefined;
  private nextAttemptId = 1;

  begin(attempt: ProviderEvidenceAttempt): ProviderEvidencePendingSnapshot {
    const attemptId = this.nextAttemptId++;
    const toolIds = new Set(attempt.toolIds);
    if (!this.pending) {
      this.pending = {
        firstAttemptId: attemptId,
        lastAttemptId: attemptId,
        attempts: 1,
        sessionEpoch: attempt.sessionEpoch,
        provider: attempt.provider,
        model: attempt.model,
        contentRevision: attempt.contentRevision,
        statePath: attempt.statePath,
        sessionId: attempt.sessionId,
        toolIds,
        opportunityAvailable: Boolean(attempt.opportunityAvailable),
        ambiguous: !attemptHasIdentity(attempt),
      };
      return this.snapshot()!;
    }

    const pending = this.pending;
    const sameAttemptShape =
      pending.sessionEpoch === attempt.sessionEpoch &&
      pending.provider === attempt.provider &&
      pending.model === attempt.model &&
      pending.contentRevision === attempt.contentRevision &&
      pending.statePath === attempt.statePath &&
      pending.sessionId === attempt.sessionId &&
      pending.opportunityAvailable === Boolean(attempt.opportunityAvailable) &&
      sameStringSet(pending.toolIds, toolIds);

    pending.lastAttemptId = attemptId;
    pending.attempts++;
    if (!sameAttemptShape || !attemptHasIdentity(attempt)) pending.ambiguous = true;
    return this.snapshot()!;
  }

  complete(finalMessage: ProviderEvidenceFinalMessage): ProviderEvidenceCompletion {
    const pending = this.pending;
    this.pending = undefined;
    if (!pending) return { status: "refused", reason: "no-pending", attempts: 0 };

    const successfulStopReasons = new Set(["stop", "length", "toolUse", "deferred"]);
    if (!finalMessage.stopReason || !successfulStopReasons.has(finalMessage.stopReason)) {
      return { status: "refused", reason: "terminal-failure", attempts: pending.attempts };
    }
    if (pending.ambiguous) {
      return { status: "refused", reason: "ambiguous", attempts: pending.attempts };
    }
    if (!pending.provider || !pending.model || !pending.contentRevision || !finalMessage.provider || !finalMessage.model) {
      return { status: "refused", reason: "missing-identity", attempts: pending.attempts };
    }
    if (pending.sessionEpoch !== finalMessage.sessionEpoch) {
      return { status: "refused", reason: "stale-session", attempts: pending.attempts };
    }
    if (pending.provider !== finalMessage.provider || pending.model !== finalMessage.model) {
      return { status: "refused", reason: "identity-mismatch", attempts: pending.attempts };
    }

    return {
      status: "promote",
      firstAttemptId: pending.firstAttemptId,
      lastAttemptId: pending.lastAttemptId,
      attempts: pending.attempts,
      sessionEpoch: pending.sessionEpoch,
      statePath: pending.statePath,
      sessionId: pending.sessionId,
      toolIds: new Set(pending.toolIds),
      opportunityAvailable: pending.opportunityAvailable,
    };
  }

  snapshot(): ProviderEvidencePendingSnapshot | undefined {
    if (!this.pending) return undefined;
    return { ...this.pending, toolIds: new Set(this.pending.toolIds) };
  }

  reset(): void {
    this.pending = undefined;
  }
}
