import type {
  HeadsUpDetails,
  HeadsUpEvidence,
  HeadsUpLastCheck,
  HeadsUpNotice,
  HeadsUpPhase,
  HeadsUpSnapshot,
} from "../../../src/bundled-extensions/heads-up/contract";
import { MAX_HEADS_UP_NOTICES } from "../../../src/bundled-extensions/heads-up/contract";
import { HEADS_UP_CONFIG_LIMITS } from "../../../src/bundled-extensions/heads-up/config";

export type { HeadsUpDetails, HeadsUpEvidence, HeadsUpLastCheck, HeadsUpNotice, HeadsUpPhase, HeadsUpSnapshot };

export const HEADS_UP_CHANNEL = "heads-up";

const PHASES: ReadonlySet<string> = new Set([
  "off", "idle", "checking", "cooldown", "unavailable", "limited", "error",
]);
const MAX_STRING = 4_096;
const MAX_MODEL = 512;
const MAX_EVIDENCE = 4;
const MAX_REVISION = Number.MAX_SAFE_INTEGER;
const CHECK_RESULTS: ReadonlySet<string> = new Set([
  "running", "none", "notice", "duplicate", "invalid", "error", "timeout", "cancelled",
]);
const CONFIG_KEYS = [
  "minTurns", "minIntervalMs", "maxChecksPerHour", "maxInputChars", "maxInputCharsPerHour",
  "maxTokens", "timeoutMs", "noticeTtlMs",
] as const;

function record(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function keysAre(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.prototype.hasOwnProperty.call(value, key))
    && Object.keys(value).every((key) => allowed.has(key));
}

function boundedString(value: unknown, max = MAX_STRING): value is string {
  return typeof value === "string" && value.length <= max && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\p{Cf}]/u.test(value);
}

function identifier(value: unknown, max = 128): value is string {
  return typeof value === "string" && value.length <= max && /^[a-zA-Z0-9:_-]+$/.test(value);
}

function nonNegativeInteger(value: unknown, max = MAX_REVISION): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= max;
}

function parseEvidence(value: unknown): HeadsUpEvidence | undefined {
  if (!record(value) || !keysAre(value, ["id", "text"])) return undefined;
  if (!identifier(value.id) || !boundedString(value.text, 1500) || !value.text.trim()) return undefined;
  return { id: value.id, text: value.text };
}

function parseDetails(value: unknown): HeadsUpDetails | undefined {
  if (!record(value) || !keysAre(value, [
    "config", "newTurns", "intervalEligibleAt", "checksInWindow", "inputCharsInWindow", "windowResetsAt", "lastCheck",
  ])) return undefined;
  const config = value.config;
  if (!record(config) || !keysAre(config, CONFIG_KEYS)
    || CONFIG_KEYS.some((key) => !nonNegativeInteger(config[key], HEADS_UP_CONFIG_LIMITS[key][1]) || (config[key] as number) < HEADS_UP_CONFIG_LIMITS[key][0])
    || !nonNegativeInteger(value.newTurns) || !nonNegativeInteger(value.intervalEligibleAt)
    || !nonNegativeInteger(value.checksInWindow) || !nonNegativeInteger(value.inputCharsInWindow)
    || (value.windowResetsAt !== null && !nonNegativeInteger(value.windowResetsAt))) return undefined;
  let lastCheck: HeadsUpLastCheck | null = null;
  if (value.lastCheck !== null) {
    if (!record(value.lastCheck) || !keysAre(value.lastCheck, ["startedAt", "finishedAt", "durationMs", "result"])
      || !nonNegativeInteger(value.lastCheck.startedAt)
      || (value.lastCheck.finishedAt !== null && !nonNegativeInteger(value.lastCheck.finishedAt))
      || (value.lastCheck.durationMs !== null && !nonNegativeInteger(value.lastCheck.durationMs))
      || typeof value.lastCheck.result !== "string" || !CHECK_RESULTS.has(value.lastCheck.result)
      || (value.lastCheck.finishedAt !== null && value.lastCheck.finishedAt < value.lastCheck.startedAt)
      || (value.lastCheck.result === "running"
        ? value.lastCheck.finishedAt !== null || value.lastCheck.durationMs !== null
        : value.lastCheck.finishedAt === null || value.lastCheck.durationMs === null)) return undefined;
    lastCheck = {
      startedAt: value.lastCheck.startedAt,
      finishedAt: value.lastCheck.finishedAt,
      durationMs: value.lastCheck.durationMs,
      result: value.lastCheck.result as HeadsUpLastCheck["result"],
    };
  }
  return {
    config: { ...config } as HeadsUpDetails["config"],
    newTurns: value.newTurns,
    intervalEligibleAt: value.intervalEligibleAt,
    checksInWindow: value.checksInWindow,
    inputCharsInWindow: value.inputCharsInWindow,
    windowResetsAt: value.windowResetsAt,
    lastCheck,
  };
}

function parseNotice(value: unknown): HeadsUpNotice | null | undefined {
  if (value === null) return null;
  if (!record(value) || !keysAre(value, ["id", "title", "consequence", "evidence", "createdAt", "expiresAt"])) return undefined;
  if (!identifier(value.id)
    || !boundedString(value.title, 160) || !value.title.trim() || !boundedString(value.consequence, 500) || !value.consequence.trim()
    || !Array.isArray(value.evidence) || value.evidence.length < 1 || value.evidence.length > MAX_EVIDENCE
    || !nonNegativeInteger(value.createdAt) || !nonNegativeInteger(value.expiresAt)
    || value.expiresAt <= value.createdAt || value.expiresAt - value.createdAt > 3_600_000) return undefined;
  const evidence: HeadsUpEvidence[] = [];
  for (const item of value.evidence) {
    const parsed = parseEvidence(item);
    if (!parsed) return undefined;
    evidence.push(parsed);
  }
  if (new Set(evidence.map((item) => item.id)).size !== evidence.length) return undefined;
  return {
    id: value.id,
    title: value.title,
    consequence: value.consequence,
    evidence,
    createdAt: value.createdAt,
    expiresAt: value.expiresAt,
  };
}

/** Strictly decode the portable heads-up snapshot carried by the ACP state bridge. */
export function parseHeadsUpSnapshot(value: unknown): HeadsUpSnapshot | undefined {
  if (!record(value) || !keysAre(value,
    ["version", "instanceId", "revision", "enabled", "model", "phase", "checks", "inputTokens", "outputTokens", "notice"],
    ["reason", "details", "notices", "awaitingReview"],
  )) return undefined;
  if (value.version !== 1 || !identifier(value.instanceId)
    || !nonNegativeInteger(value.revision) || typeof value.enabled !== "boolean"
    || !boundedString(value.model, MAX_MODEL) || !/^[^\s/]+\/[^\s]+$/.test(value.model) || typeof value.phase !== "string" || !PHASES.has(value.phase)
    || !nonNegativeInteger(value.checks) || !nonNegativeInteger(value.inputTokens)
    || !nonNegativeInteger(value.outputTokens) || ("reason" in value && !boundedString(value.reason, 512))) return undefined;
  const notice = parseNotice(value.notice);
  if ("awaitingReview" in value && typeof value.awaitingReview !== "boolean") return undefined;
  const details = "details" in value ? parseDetails(value.details) : undefined;
  if (notice === undefined || ("details" in value && !details)) return undefined;
  let notices: HeadsUpNotice[] | undefined;
  if ("notices" in value) {
    if (!Array.isArray(value.notices) || value.notices.length > MAX_HEADS_UP_NOTICES) return undefined;
    notices = [];
    for (const item of value.notices) {
      const parsed = parseNotice(item);
      if (!parsed) return undefined;
      notices.push(parsed);
    }
    if (new Set(notices.map((item) => item.id)).size !== notices.length
      || (notices.length === 0 ? notice !== null : notice === null || !notices.some((item) => item.id === notice.id && JSON.stringify(item) === JSON.stringify(notice)))) return undefined;
  }
  if ((!value.enabled && (notice !== null || (notices?.length ?? 0) > 0)) || (!value.enabled && value.phase !== "off")) return undefined;
  if (value.awaitingReview === true && (!value.enabled || value.phase === "off" || notice !== null || (notices?.length ?? 0) > 0)) return undefined;
  return {
    version: 1,
    instanceId: value.instanceId,
    revision: value.revision,
    enabled: value.enabled,
    model: value.model,
    phase: value.phase as HeadsUpPhase,
    checks: value.checks,
    inputTokens: value.inputTokens,
    outputTokens: value.outputTokens,
    notice,
    ...(notices ? { notices } : {}),
    ...(typeof value.awaitingReview === "boolean" ? { awaitingReview: value.awaitingReview } : {}),
    ...(details ? { details } : {}),
    ...(typeof value.reason === "string" ? { reason: value.reason } : {}),
  };
}

export function noticeIsCurrent(notice: HeadsUpNotice | null, now = Date.now()): notice is HeadsUpNotice {
  return notice !== null && notice.expiresAt > now;
}
