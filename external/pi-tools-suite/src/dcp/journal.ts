import { randomUUID } from "node:crypto";
import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import type {
  CompressionBlock,
  DcpLastNudge,
  DcpNudgeAnchor,
  DcpState,
} from "./state.js";

export const DCP_JOURNAL_CUSTOM_TYPE = "dcp-journal";
export const DCP_JOURNAL_SCHEMA_VERSION = 1;

const MAX_JOURNAL_OPERATION_BYTES = 1_000_000;
const JOURNAL_DURABLE_TAIL_BYTES = MAX_JOURNAL_OPERATION_BYTES + 128 * 1024;
const MAX_ASSIGNMENTS_PER_OPERATION = 20_000;
const MAX_BLOCKS_PER_OPERATION = 1_000;
const MAX_PRUNES_PER_OPERATION = 20_000;

export interface DcpJournalInitOperation {
  schemaVersion: 1;
  kind: "init";
  operationId: string;
  previousOperationId: null;
  createdAt: number;
}

export interface DcpJournalPrunedTool {
  toolCallId: string;
  reason: string;
  tokenEstimate: number;
}

export interface DcpJournalBlockState {
  id: number;
  active: boolean;
  deactivatedReason?: string;
}

export interface DcpJournalDeltaOperation {
  schemaVersion: 1;
  kind: "delta";
  operationId: string;
  previousOperationId: string;
  createdAt: number;
  messageAssignments?: Array<[stableId: string, visibleId: string]>;
  nextMessageId?: number;
  blocks?: CompressionBlock[];
  blockStates?: DcpJournalBlockState[];
  prunedTools?: DcpJournalPrunedTool[];
  manualMode?: boolean;
  nudgeAnchors?: DcpNudgeAnchor[];
  nextNudgeAnchorId?: number;
  lastNudge?: DcpLastNudge | null;
}

export type DcpJournalOperation = DcpJournalInitOperation | DcpJournalDeltaOperation;

export interface DcpJournalReplayResult {
  initialized: boolean;
  lastOperationId?: string;
  operationCount: number;
}

export interface DcpJournalPublicationOptions {
  beforePublish?: () => void;
  onPublished?: () => void;
}

export interface DcpJournalMirror {
  lastOperationId: string;
  messageAssignments: Map<string, string>;
  blocks: Map<number, string>;
  blockImmutable: Map<number, string>;
  blockStates: Map<number, string>;
  inactiveBlocks: Set<number>;
  prunedTools: Set<string>;
  manualMode: boolean;
  nudgeState: string;
}

export class DcpJournalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DcpJournalError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finiteNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function assertBounded(operation: DcpJournalOperation): void {
  const bytes = Buffer.byteLength(JSON.stringify(operation), "utf8");
  if (bytes > MAX_JOURNAL_OPERATION_BYTES) {
    throw new DcpJournalError(`DCP journal operation exceeds ${MAX_JOURNAL_OPERATION_BYTES} bytes`);
  }
}

function validateExactBlock(value: unknown): asserts value is CompressionBlock {
  if (!isRecord(value)) throw new DcpJournalError("DCP journal block must be an object");
  if (!finiteNonNegativeInteger(value.id) || value.id < 1) throw new DcpJournalError("DCP journal block id is invalid");
  if (value.version !== 2) throw new DcpJournalError(`DCP journal block b${value.id} is not v2 exact`);
  if (value.replacementMode !== "range" && value.replacementMode !== "message-body") {
    throw new DcpJournalError(`DCP journal block b${value.id} has invalid replacement mode`);
  }
  for (const key of ["topic", "summary", "startMessageId", "endMessageId"] as const) {
    if (typeof value[key] !== "string" || value[key].length === 0) {
      throw new DcpJournalError(`DCP journal block b${value.id} is missing ${key}`);
    }
  }
  for (const key of ["startTimestamp", "endTimestamp", "anchorTimestamp", "summaryTokenEstimate", "createdAt"] as const) {
    if (typeof value[key] !== "number" || !Number.isFinite(value[key])) {
      throw new DcpJournalError(`DCP journal block b${value.id} has invalid ${key}`);
    }
  }
  for (const key of ["sourceMembers", "mutationMembers"] as const) {
    const members = value[key];
    if (!Array.isArray(members) || members.length === 0) {
      throw new DcpJournalError(`DCP journal block b${value.id} is missing exact ${key}`);
    }
    const seen = new Set<string>();
    for (const member of members) {
      if (!isRecord(member) || typeof member.stableId !== "string" || member.stableId.length === 0 || typeof member.hash !== "string" || member.hash.length === 0) {
        throw new DcpJournalError(`DCP journal block b${value.id} has malformed ${key}`);
      }
      if (seen.has(member.stableId)) throw new DcpJournalError(`DCP journal block b${value.id} repeats ${member.stableId}`);
      seen.add(member.stableId);
    }
  }
  if (!Array.isArray(value.protectedFragments)) {
    throw new DcpJournalError(`DCP journal block b${value.id} is missing protectedFragments`);
  }
  for (const fragment of value.protectedFragments) {
    if (!isRecord(fragment)
      || (fragment.kind !== "user" && fragment.kind !== "prompt" && fragment.kind !== "tool")
      || typeof fragment.origin !== "string" || fragment.origin.length === 0
      || typeof fragment.hash !== "string" || !/^[a-f0-9]{64}$/i.test(fragment.hash)
      || typeof fragment.text !== "string") {
      throw new DcpJournalError(`DCP journal block b${value.id} has malformed protectedFragments`);
    }
  }
}

function validateAnchor(value: unknown): value is DcpNudgeAnchor {
  if (!isRecord(value)) return false;
  return finiteNonNegativeInteger(value.id)
    && typeof value.type === "string"
    && typeof value.anchorRole === "string"
    && typeof value.turnIndex === "number"
    && typeof value.createdAt === "number"
    && typeof value.updatedAt === "number"
    && typeof value.anchorTimestamp === "number"
    && (value.anchorStableId === undefined || typeof value.anchorStableId === "string")
    && (value.renderedReminder === undefined || typeof value.renderedReminder === "string");
}

export function validateDcpJournalOperation(value: unknown): DcpJournalOperation {
  if (!isRecord(value)) throw new DcpJournalError("DCP journal operation must be an object");
  if (value.schemaVersion !== DCP_JOURNAL_SCHEMA_VERSION) throw new DcpJournalError("Unsupported DCP journal schema version");
  if (typeof value.operationId !== "string" || value.operationId.length < 8 || value.operationId.length > 200) {
    throw new DcpJournalError("DCP journal operationId is invalid");
  }
  if (typeof value.createdAt !== "number" || !Number.isFinite(value.createdAt)) throw new DcpJournalError("DCP journal createdAt is invalid");
  if (value.kind === "init") {
    if (value.previousOperationId !== null) throw new DcpJournalError("DCP journal init must start a chain");
    const operation = value as unknown as DcpJournalInitOperation;
    assertBounded(operation);
    return operation;
  }
  if (value.kind !== "delta") throw new DcpJournalError("Unsupported DCP journal operation kind");
  if (typeof value.previousOperationId !== "string" || value.previousOperationId.length === 0) {
    throw new DcpJournalError("DCP journal delta is missing previousOperationId");
  }
  if (value.messageAssignments !== undefined) {
    if (!Array.isArray(value.messageAssignments) || value.messageAssignments.length > MAX_ASSIGNMENTS_PER_OPERATION) {
      throw new DcpJournalError("DCP journal message assignments are invalid");
    }
    for (const assignment of value.messageAssignments) {
      if (!Array.isArray(assignment) || assignment.length !== 2 || typeof assignment[0] !== "string" || !assignment[0]
        || typeof assignment[1] !== "string" || !/^m\d+$/.test(assignment[1])) {
        throw new DcpJournalError("DCP journal message assignment is malformed");
      }
    }
  }
  if (value.nextMessageId !== undefined && (!finiteNonNegativeInteger(value.nextMessageId) || value.nextMessageId < 1)) {
    throw new DcpJournalError("DCP journal nextMessageId is invalid");
  }
  if (value.blocks !== undefined) {
    if (!Array.isArray(value.blocks) || value.blocks.length > MAX_BLOCKS_PER_OPERATION) throw new DcpJournalError("DCP journal blocks are invalid");
    for (const block of value.blocks) validateExactBlock(block);
  }
  if (value.blockStates !== undefined) {
    if (!Array.isArray(value.blockStates) || value.blockStates.length > MAX_BLOCKS_PER_OPERATION) throw new DcpJournalError("DCP journal block states are invalid");
    for (const state of value.blockStates) {
      if (!isRecord(state) || !finiteNonNegativeInteger(state.id) || state.id < 1 || typeof state.active !== "boolean"
        || (state.deactivatedReason !== undefined && typeof state.deactivatedReason !== "string")) {
        throw new DcpJournalError("DCP journal block state is malformed");
      }
    }
  }
  if (value.prunedTools !== undefined) {
    if (!Array.isArray(value.prunedTools) || value.prunedTools.length > MAX_PRUNES_PER_OPERATION) throw new DcpJournalError("DCP journal pruned tools are invalid");
    for (const item of value.prunedTools) {
      if (!isRecord(item) || typeof item.toolCallId !== "string" || !item.toolCallId || typeof item.reason !== "string"
        || typeof item.tokenEstimate !== "number" || !Number.isFinite(item.tokenEstimate) || item.tokenEstimate < 0) {
        throw new DcpJournalError("DCP journal pruned tool is malformed");
      }
    }
  }
  if (value.manualMode !== undefined && typeof value.manualMode !== "boolean") throw new DcpJournalError("DCP journal manualMode is invalid");
  if (value.nudgeAnchors !== undefined && (!Array.isArray(value.nudgeAnchors) || !value.nudgeAnchors.every(validateAnchor))) {
    throw new DcpJournalError("DCP journal nudge anchors are invalid");
  }
  if (value.nextNudgeAnchorId !== undefined && (!finiteNonNegativeInteger(value.nextNudgeAnchorId) || value.nextNudgeAnchorId < 1)) {
    throw new DcpJournalError("DCP journal nextNudgeAnchorId is invalid");
  }
  if (value.lastNudge !== undefined && value.lastNudge !== null && !isRecord(value.lastNudge)) {
    throw new DcpJournalError("DCP journal lastNudge is invalid");
  }
  const operation = value as unknown as DcpJournalDeltaOperation;
  assertBounded(operation);
  return operation;
}

function blockStateKey(block: CompressionBlock): string {
  return stableJson({ active: block.active, deactivatedReason: block.deactivatedReason });
}

function immutableBlockKey(block: CompressionBlock): string {
  const { active: _active, deactivatedReason: _deactivatedReason, ...immutable } = block;
  return stableJson(immutable);
}

function nudgeStateKey(state: Pick<DcpState, "nudgeAnchors" | "nextNudgeAnchorId" | "lastNudge">): string {
  return stableJson({
    nudgeAnchors: state.nudgeAnchors,
    nextNudgeAnchorId: state.nextNudgeAnchorId,
    lastNudge: state.lastNudge ?? null,
  });
}

export function createDcpJournalMirror(state: DcpState, lastOperationId: string): DcpJournalMirror {
  return {
    lastOperationId,
    messageAssignments: new Map(state.messageIdsByStableId),
    blocks: new Map(state.compressionBlocks.map((block) => [block.id, stableJson(block)])),
    blockImmutable: new Map(state.compressionBlocks.map((block) => [block.id, immutableBlockKey(block)])),
    blockStates: new Map(state.compressionBlocks.map((block) => [block.id, blockStateKey(block)])),
    inactiveBlocks: new Set(state.compressionBlocks.filter((block) => !block.active).map((block) => block.id)),
    prunedTools: new Set(state.prunedToolIds),
    manualMode: state.manualMode,
    nudgeState: nudgeStateKey(state),
  };
}

export function createDcpJournalInit(operationId: string = randomUUID(), createdAt = Date.now()): DcpJournalInitOperation {
  return {
    schemaVersion: DCP_JOURNAL_SCHEMA_VERSION,
    kind: "init",
    operationId,
    previousOperationId: null,
    createdAt,
  };
}

export function buildDcpJournalDelta(
  state: DcpState,
  mirror: DcpJournalMirror,
  operationId: string = randomUUID(),
  createdAt = Date.now(),
): DcpJournalDeltaOperation | undefined {
  for (const [stableId, visibleId] of mirror.messageAssignments) {
    const current = state.messageIdsByStableId.get(stableId);
    if (current === undefined) throw new DcpJournalError(`Published message assignment ${stableId} was removed`);
    if (current !== visibleId) throw new DcpJournalError(`Published message assignment ${stableId} was reassigned`);
  }
  const currentBlocksById = new Map(state.compressionBlocks.map((block) => [block.id, block]));
  for (const blockId of mirror.blocks.keys()) {
    if (!currentBlocksById.has(blockId)) throw new DcpJournalError(`Published DCP block b${blockId} was removed`);
  }
  for (const toolCallId of mirror.prunedTools) {
    if (!state.prunedToolIds.has(toolCallId)) throw new DcpJournalError(`Published pruned tool ${toolCallId} was restored`);
  }
  for (const blockId of mirror.inactiveBlocks) {
    if (currentBlocksById.get(blockId)?.active) throw new DcpJournalError(`Retired DCP block b${blockId} was reactivated`);
  }

  const messageAssignments = [...state.messageIdsByStableId.entries()].filter(([stableId, visibleId]) => mirror.messageAssignments.get(stableId) !== visibleId);
  const blocks = state.compressionBlocks.filter((block) => mirror.blocks.get(block.id) !== stableJson(block));
  const newBlockIds = new Set(blocks.filter((block) => !mirror.blocks.has(block.id)).map((block) => block.id));
  const newBlocks = blocks.filter((block) => newBlockIds.has(block.id));
  const changedExistingBlocks = blocks.filter((block) => mirror.blocks.has(block.id));
  const blockStates = changedExistingBlocks.map((block) => ({
    id: block.id,
    active: block.active,
    ...(block.deactivatedReason ? { deactivatedReason: block.deactivatedReason } : {}),
  }));
  // Existing blocks are immutable except for active/deactivation state. If any
  // other field changed, fail rather than silently turning an update into a new
  // representation of an already provider-visible summary.
  for (const block of changedExistingBlocks) {
    if (mirror.blockImmutable.get(block.id) !== immutableBlockKey(block)) {
      throw new DcpJournalError(`DCP block b${block.id} changed after publication`);
    }
  }
  const prunedTools: DcpJournalPrunedTool[] = [];
  for (const toolCallId of state.prunedToolIds) {
    if (mirror.prunedTools.has(toolCallId)) continue;
    prunedTools.push({
      toolCallId,
      reason: state.prunedToolReasons.get(toolCallId) ?? "pruned",
      tokenEstimate: Math.max(0, Math.round(state.toolCalls.get(toolCallId)?.tokenEstimate ?? 0)),
    });
  }
  const nudgeChanged = nudgeStateKey(state) !== mirror.nudgeState;
  const manualMode = state.manualMode !== mirror.manualMode ? state.manualMode : undefined;
  if (messageAssignments.length === 0 && blocks.length === 0 && blockStates.length === 0 && prunedTools.length === 0 && manualMode === undefined && !nudgeChanged) {
    return undefined;
  }
  const operation: DcpJournalDeltaOperation = {
    schemaVersion: DCP_JOURNAL_SCHEMA_VERSION,
    kind: "delta",
    operationId,
    previousOperationId: mirror.lastOperationId,
    createdAt,
    ...(messageAssignments.length > 0 ? { messageAssignments, nextMessageId: state.nextMessageId } : {}),
    ...(newBlocks.length > 0 ? { blocks: newBlocks } : {}),
    ...(blockStates.length > 0 ? { blockStates } : {}),
    ...(prunedTools.length > 0 ? { prunedTools } : {}),
    ...(manualMode === undefined ? {} : { manualMode }),
    ...(nudgeChanged ? {
      nudgeAnchors: structuredClone(state.nudgeAnchors),
      nextNudgeAnchorId: state.nextNudgeAnchorId,
      lastNudge: state.lastNudge ? structuredClone(state.lastNudge) : null,
    } : {}),
  };
  return validateDcpJournalOperation(operation) as DcpJournalDeltaOperation;
}

function applyDelta(state: DcpState, delta: DcpJournalDeltaOperation): void {
  if (delta.messageAssignments) {
    const usedIds = new Set(state.messageIdsByStableId.values());
    for (const [stableId, visibleId] of delta.messageAssignments) {
      const existing = state.messageIdsByStableId.get(stableId);
      if (existing && existing !== visibleId) throw new DcpJournalError(`Stable message ${stableId} was reassigned`);
      if (!existing && usedIds.has(visibleId)) throw new DcpJournalError(`Visible message ID ${visibleId} was reused`);
      state.messageIdsByStableId.set(stableId, visibleId);
      usedIds.add(visibleId);
    }
  }
  if (delta.nextMessageId !== undefined) state.nextMessageId = Math.max(state.nextMessageId, delta.nextMessageId);
  if (delta.blocks) {
    for (const raw of delta.blocks) {
      validateExactBlock(raw);
      const existing = state.compressionBlocks.find((block) => block.id === raw.id);
      if (existing) {
        if (stableJson(existing) !== stableJson(raw)) throw new DcpJournalError(`Compression block b${raw.id} conflicts with an earlier operation`);
        continue;
      }
      state.compressionBlocks.push(structuredClone(raw));
      state.nextBlockId = Math.max(state.nextBlockId, raw.id + 1);
    }
  }
  if (delta.blockStates) {
    for (const update of delta.blockStates) {
      const block = state.compressionBlocks.find((candidate) => candidate.id === update.id);
      if (!block) throw new DcpJournalError(`Block state refers to unknown b${update.id}`);
      if (!block.active && update.active) throw new DcpJournalError(`Retired DCP block b${update.id} cannot be reactivated`);
      block.active = update.active;
      block.deactivatedReason = update.deactivatedReason;
    }
  }
  if (delta.prunedTools) {
    for (const item of delta.prunedTools) {
      if (state.prunedToolIds.has(item.toolCallId)) continue;
      state.prunedToolIds.add(item.toolCallId);
      state.prunedToolReasons.set(item.toolCallId, item.reason);
      state.accountedPrunedToolIds.add(item.toolCallId);
      state.totalPruneCount += 1;
      state.tokensSaved += Math.max(0, Math.round(item.tokenEstimate));
    }
  }
  if (delta.manualMode !== undefined) state.manualMode = delta.manualMode;
  if (delta.nudgeAnchors !== undefined) state.nudgeAnchors = structuredClone(delta.nudgeAnchors);
  if (delta.nextNudgeAnchorId !== undefined) state.nextNudgeAnchorId = delta.nextNudgeAnchorId;
  if (delta.lastNudge !== undefined) state.lastNudge = delta.lastNudge === null ? undefined : structuredClone(delta.lastNudge);
}

export function replayDcpJournal(entries: readonly unknown[], state: DcpState): DcpJournalReplayResult {
  const operations: DcpJournalOperation[] = [];
  for (const entry of entries) {
    if (!isRecord(entry) || entry.type !== "custom" || entry.customType !== DCP_JOURNAL_CUSTOM_TYPE) continue;
    operations.push(validateDcpJournalOperation(entry.data));
  }
  if (operations.length === 0) return { initialized: false, operationCount: 0 };
  const first = operations[0]!;
  if (first.kind !== "init") throw new DcpJournalError("DCP journal does not begin with init");
  let previous = first.operationId;
  const seen = new Map<string, string>([[first.operationId, stableJson(first)]]);
  for (let index = 1; index < operations.length; index += 1) {
    const operation = operations[index]!;
    const fingerprint = stableJson(operation);
    const existing = seen.get(operation.operationId);
    if (existing !== undefined) {
      if (existing !== fingerprint) throw new DcpJournalError(`DCP journal operation ${operation.operationId} conflicts with an earlier operation`);
      continue;
    }
    if (operation.kind !== "delta") throw new DcpJournalError("DCP journal contains a second init operation");
    if (operation.previousOperationId !== previous) throw new DcpJournalError(`DCP journal predecessor mismatch at ${operation.operationId}`);
    applyDelta(state, operation);
    seen.set(operation.operationId, fingerprint);
    previous = operation.operationId;
  }
  return { initialized: true, lastOperationId: previous, operationCount: operations.length };
}

function journalBranch(ctx: ExtensionContext): unknown[] {
  try {
    const branch = ctx.sessionManager.getBranch();
    return Array.isArray(branch) ? branch : [];
  } catch {
    return [];
  }
}

export async function readDcpJournalBranch(ctx: ExtensionContext): Promise<unknown[]> {
  const manager = ctx.sessionManager as any;
  if (typeof manager.readFullBranchEntries === "function") {
    const entries = await manager.readFullBranchEntries();
    return Array.isArray(entries) ? entries : [];
  }
  return journalBranch(ctx);
}

function restoreLeafAfterAppendFailure(ctx: ExtensionContext, previousLeafId: string | null | undefined): void {
  const manager = ctx.sessionManager as any;
  try {
    if (previousLeafId) manager.branch?.(previousLeafId);
    else manager.resetLeaf?.();
  } catch {
    // The append error remains authoritative. A reload is required before DCP
    // can safely publish another operation.
  }
}

function branchContainsJournalOperation(ctx: ExtensionContext, operationId: string): boolean {
  return journalBranch(ctx).some((entry: any) =>
    entry?.type === "custom"
      && entry.customType === DCP_JOURNAL_CUSTOM_TYPE
      && entry.data?.operationId === operationId,
  );
}

/**
 * `ExtensionAPI.appendEntry()` writes through SessionManager and then emits an
 * `entry_appended` event. A listener can therefore throw after the JSONL append
 * already succeeded. On the error path only, inspect the bounded durable tail
 * so a confirmed commit is not reported as an uncommitted mutation. This is a
 * read-only reconciliation check, not a second persistence backend.
 */
function durableJournalOperationPresent(ctx: ExtensionContext, operationId: string): boolean {
  const manager = ctx.sessionManager as any;
  let sessionFile: unknown;
  try {
    sessionFile = manager.getSessionFile?.();
  } catch {
    return false;
  }
  if (typeof sessionFile !== "string" || sessionFile.length === 0) return false;

  let fd: number | undefined;
  try {
    fd = openSync(sessionFile, "r");
    const size = fstatSync(fd).size;
    if (size <= 0) return false;
    const length = Math.min(size, JOURNAL_DURABLE_TAIL_BYTES);
    const buffer = Buffer.allocUnsafe(length);
    const bytes = readSync(fd, buffer, 0, length, size - length);
    const lines = buffer.subarray(0, bytes).toString("utf8").split("\n");
    // The first line may begin in the middle of a large preceding JSON record;
    // malformed/partial lines are ignored and never count as a durable commit.
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const line = lines[index]!.trim();
      if (!line) continue;
      try {
        const entry = JSON.parse(line);
        if (
          entry?.type === "custom"
          && entry.customType === DCP_JOURNAL_CUSTOM_TYPE
          && entry.data?.operationId === operationId
        ) return true;
      } catch {
        // Keep scanning complete earlier lines in the bounded tail.
      }
    }
  } catch {
    return false;
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* best-effort reconciliation read */ }
    }
  }
  return false;
}

export function appendDcpJournalOperation(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  operation: DcpJournalOperation,
): void {
  validateDcpJournalOperation(operation);
  const manager = ctx.sessionManager as any;
  const previousLeafId = typeof manager.getLeafId === "function" ? manager.getLeafId() : undefined;
  try {
    pi.appendEntry(DCP_JOURNAL_CUSTOM_TYPE, operation);
  } catch (error) {
    const durable = durableJournalOperationPresent(ctx, operation.operationId);
    if (durable && branchContainsJournalOperation(ctx, operation.operationId)) {
      // The session write committed and only post-append notification failed.
      // Treat it as committed so callers do not retry the mutation.
      return;
    }
    if (durable) {
      throw new DcpJournalError(
        "DCP journal append is durable but the active in-memory branch no longer agrees; reload the session before continuing",
      );
    }
    restoreLeafAfterAppendFailure(ctx, previousLeafId);
    throw new DcpJournalError(`Failed to append DCP journal operation: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!branchContainsJournalOperation(ctx, operation.operationId)) {
    restoreLeafAfterAppendFailure(ctx, previousLeafId);
    throw new DcpJournalError("DCP journal append did not become part of the active session branch");
  }
}


export function appendDcpJournalDelta(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  state: DcpState,
  mirror: DcpJournalMirror,
  publication: DcpJournalPublicationOptions = {},
): DcpJournalMirror {
  const delta = buildDcpJournalDelta(state, mirror);
  if (!delta) return mirror;
  publication.beforePublish?.();
  appendDcpJournalOperation(pi, ctx, delta);
  publication.onPublished?.();
  return createDcpJournalMirror(state, delta.operationId);
}
