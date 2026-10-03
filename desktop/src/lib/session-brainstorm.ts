import type { SessionStateNotification } from "./session-state";

export const BRAINSTORM_STATE_CHANNEL = "pi-tools-suite:brainstorm:state";

export type BrainstormStatus = "running" | "awaiting_synthesis" | "awaiting_finalization" | "complete" | "incomplete";
export type BrainstormParticipantStatus = "planned" | "running" | "done" | "failed" | "stopped";

export interface BrainstormParticipant {
  readonly slot: number;
  readonly sessionId: string;
  readonly name: string;
  readonly model: string;
  readonly status: BrainstormParticipantStatus;
  readonly round: number;
}

export interface BrainstormRun {
  readonly runId: string;
  readonly runDir: string;
  readonly topic: string;
  readonly status: BrainstormStatus;
  readonly round: number;
  readonly participants: BrainstormParticipant[];
}

export interface SessionBrainstormSnapshot {
  readonly version: 1;
  readonly checkedAt: number;
  readonly runs: BrainstormRun[];
}

export interface BrainstormSessionLink {
  readonly runId: string;
  readonly parentSessionId: string;
  readonly slot: number;
  readonly owned: boolean;
}

/** Linkage is protocol metadata, never inferred from a renameable title. */
export function brainstormSessionLink(
  sessionId: string | null,
  metadata: unknown,
  snapshots: ReadonlyMap<string, SessionBrainstormSnapshot>,
): BrainstormSessionLink | undefined {
  if (!sessionId) return undefined;
  const candidate = record(metadata) ? metadata["pix.brainstorm"] : undefined;
  const link = record(candidate) && nonEmpty(candidate.runId) && nonEmpty(candidate.parentSessionId)
    && Number.isInteger(candidate.slot) && (candidate.slot as number) > 0 && typeof candidate.owned === "boolean"
    ? candidate as unknown as BrainstormSessionLink : undefined;
  for (const [parentSessionId, snapshot] of snapshots) {
    for (const run of snapshot.runs) {
      const participant = run.participants.find((item) => item.sessionId === sessionId);
      if (!participant || (link && (link.runId !== run.runId || link.parentSessionId !== parentSessionId))) continue;
      const terminal = run.status === "complete" || run.status === "incomplete";
      return { runId: run.runId, parentSessionId, slot: participant.slot, owned: terminal ? false : (link?.owned ?? true) };
    }
  }
  return link;
}

const RUN_STATUSES: readonly BrainstormStatus[] = ["running", "awaiting_synthesis", "awaiting_finalization", "complete", "incomplete"];
const PARTICIPANT_STATUSES: readonly BrainstormParticipantStatus[] = ["planned", "running", "done", "failed", "stopped"];

export function sessionBrainstormSnapshot(notification: SessionStateNotification): SessionBrainstormSnapshot | undefined {
  return notification.channel === BRAINSTORM_STATE_CHANNEL && isSessionBrainstormSnapshot(notification.data)
    ? notification.data
    : undefined;
}

export function isSessionBrainstormSnapshot(value: unknown): value is SessionBrainstormSnapshot {
  if (!record(value) || value.version !== 1 || !finite(value.checkedAt) || !Array.isArray(value.runs)) return false;
  const ids = new Set<string>();
  for (const run of value.runs) {
    if (!record(run) || !nonEmpty(run.runId) || !nonEmpty(run.runDir) || typeof run.topic !== "string"
      || !RUN_STATUSES.includes(run.status as BrainstormStatus) || !positiveOrZeroInteger(run.round) || run.round > 5
      || !Array.isArray(run.participants) || run.participants.length > 6 || ids.has(run.runId)) return false;
    ids.add(run.runId);
    const slots = new Set<number>();
    const sessionIds = new Set<string>();
    for (const participant of run.participants) {
      if (!record(participant) || !positiveOrZeroInteger(participant.slot) || participant.slot < 1 || participant.slot > 6 || !nonEmpty(participant.sessionId)
        || typeof participant.name !== "string" || typeof participant.model !== "string"
        || !PARTICIPANT_STATUSES.includes(participant.status as BrainstormParticipantStatus)
        || !positiveOrZeroInteger(participant.round) || participant.round > 5 || slots.has(participant.slot) || sessionIds.has(participant.sessionId)) return false;
      slots.add(participant.slot);
      sessionIds.add(participant.sessionId);
    }
  }
  return true;
}

export function updateSessionBrainstormSnapshots(
  current: ReadonlyMap<string, SessionBrainstormSnapshot>,
  sessionId: string,
  snapshot: SessionBrainstormSnapshot,
): Map<string, SessionBrainstormSnapshot> {
  const previous = current.get(sessionId);
  if (previous && previous.checkedAt > snapshot.checkedAt) return new Map(current);
  const next = new Map(current);
  next.set(sessionId, snapshot);
  return next;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function nonEmpty(value: unknown): value is string { return typeof value === "string" && value.length > 0; }
function finite(value: unknown): value is number { return typeof value === "number" && Number.isFinite(value); }
function positiveOrZeroInteger(value: unknown): value is number { return Number.isInteger(value) && (value as number) >= 0; }
