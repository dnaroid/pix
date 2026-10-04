import type { AcpClient } from "../lib/acp-client";
import {
  HEADS_UP_CHANNEL,
  noticeIsCurrent,
  parseHeadsUpSnapshot,
  type HeadsUpNotice,
  type HeadsUpSnapshot,
} from "../lib/heads-up";
import type { Attachment } from "../lib/attachments";
import type { SessionStateNotification } from "../lib/session-state";
import { headsUpDiscussionDraft } from "../../../src/bundled-extensions/heads-up/contract";

export type HeadsUpFeedback = "known" | "irrelevant" | "dismiss";

type HeadsUpStoreOptions = {
  client: () => AcpClient | null;
  runtimeReady: (sessionId: string) => boolean;
  /** Required to request a first snapshot without risking an unknown slash prompt. */
  commandAvailable?: (sessionId: string) => boolean;
  reportError: (error: unknown) => void;
};

type StoredSnapshot = { snapshot: HeadsUpSnapshot; generation: number };

/** Desktop-only mirror for the opt-in observer. It never starts observer work. */
export function createHeadsUpStore(options: HeadsUpStoreOptions) {
  let snapshots = $state<Map<string, StoredSnapshot>>(new Map());
  let retiredInstances = new Map<string, Set<string>>();
  let selections = $state<Map<string, { instanceId: string; noticeId: string }>>(new Map());
  let pendingCommands = $state<Set<string>>(new Set());
  const commandTokens = new Map<string, symbol>();
  let nowMs = $state(Date.now());
  let lifecycleGeneration = 0;
  let expiryTimer: ReturnType<typeof setTimeout> | undefined;

  function scheduleExpiry(): void {
    if (expiryTimer !== undefined) clearTimeout(expiryTimer);
    expiryTimer = undefined;
    let nextExpiry: number | undefined;
    for (const { snapshot } of snapshots.values()) {
      for (const notice of activeNotices(snapshot)) {
        if (notice.expiresAt <= nowMs) continue;
        if (nextExpiry === undefined || notice.expiresAt < nextExpiry) nextExpiry = notice.expiresAt;
      }
    }
    if (nextExpiry === undefined) return;
    expiryTimer = setTimeout(() => {
      expiryTimer = undefined;
      nowMs = Date.now();
      for (const [sessionId, { snapshot }] of snapshots) {
        reconcileSelection(sessionId, snapshot, snapshot);
      }
      scheduleExpiry();
    }, Math.max(0, nextExpiry - Date.now()));
  }

  function activeNotices(snapshot: HeadsUpSnapshot): readonly HeadsUpNotice[] {
    return snapshot.notices ?? (snapshot.notice ? [snapshot.notice] : []);
  }

  function setSelection(sessionId: string, instanceId: string, noticeId: string): void {
    // Plain Maps are not deeply proxied by $state; assignment notifies consumers.
    selections = new Map(selections).set(sessionId, { instanceId, noticeId });
  }

  function reconcileSelection(sessionId: string, snapshot: HeadsUpSnapshot, previous?: HeadsUpSnapshot): void {
    const live = activeNotices(snapshot).filter((item) => noticeIsCurrent(item, nowMs));
    const selected = selections.get(sessionId);
    const sameOwner = previous?.instanceId === snapshot.instanceId;
    const selectedId = sameOwner ? selected?.noticeId : snapshot.notice?.id;
    if (live.some((item) => item.id === selectedId)) {
      setSelection(sessionId, snapshot.instanceId, selectedId!);
      return;
    }
    const old = sameOwner ? activeNotices(previous!) : [];
    const index = old.findIndex((item) => item.id === selectedId);
    const neighbors = [...old.slice(index + 1), ...old.slice(0, Math.max(0, index)).reverse()];
    const next = neighbors.find((item) => live.some((current) => current.id === item.id)) ?? live[0];
    setSelection(sessionId, snapshot.instanceId, next?.id ?? "");
  }

  function markRetired(sessionId: string, instanceId: string): void {
    const retired = retiredInstances.get(sessionId) ?? new Set<string>();
    retired.add(instanceId);
    while (retired.size > 32) retired.delete(retired.values().next().value!);
    retiredInstances.set(sessionId, retired);
  }

  function handleSessionState(notification: SessionStateNotification): boolean {
    if (notification.channel !== HEADS_UP_CHANNEL) return false;
    const snapshot = parseHeadsUpSnapshot(notification.data);
    if (!snapshot) return true;
    const retired = retiredInstances.get(notification.sessionId);
    if (retired?.has(snapshot.instanceId)) return true;
    const previous = snapshots.get(notification.sessionId);
    if (previous?.snapshot.instanceId === snapshot.instanceId
      && snapshot.revision <= previous.snapshot.revision) return true;
    if (previous && previous.snapshot.instanceId !== snapshot.instanceId) markRetired(notification.sessionId, previous.snapshot.instanceId);
    const generation = (previous?.generation ?? 0) + 1;
    nowMs = Date.now();
    reconcileSelection(notification.sessionId, snapshot, previous?.snapshot);
    const next = new Map(snapshots);
    next.set(notification.sessionId, { snapshot, generation });
    snapshots = next;
    scheduleExpiry();
    return true;
  }

  function state(sessionId: string | null): HeadsUpSnapshot | undefined {
    const snapshot = sessionId ? snapshots.get(sessionId)?.snapshot : undefined;
    if (!snapshot || !sessionId) return undefined;
    const live = activeNotices(snapshot).filter((item) => noticeIsCurrent(item, nowMs));
    const notice = live.find((item) => item.id === selections.get(sessionId)?.noticeId) ?? live[0] ?? null;
    // Status consumers must not report "no finding" just because the runtime's
    // selected card expired locally while another stack member remains live.
    return { ...snapshot, notice, ...(snapshot.notices ? { notices: live } : {}) };
  }

  function notice(sessionId: string | null): HeadsUpNotice | undefined {
    const current = state(sessionId);
    if (!current?.enabled || !sessionId) return undefined;
    const list = activeNotices(current).filter((item) => noticeIsCurrent(item, nowMs));
    const selected = selections.get(sessionId);
    return list.find((item) => item.id === selected?.noticeId) ?? list[0];
  }

  function notices(sessionId: string | null): readonly HeadsUpNotice[] {
    const current = state(sessionId);
    return current?.enabled ? activeNotices(current).filter((item) => noticeIsCurrent(item, nowMs)) : [];
  }

  function selectNotice(sessionId: string, noticeId: string, direction: -1 | 1, expectedInstanceId?: string): void {
    const current = state(sessionId);
    if (!current?.enabled || (expectedInstanceId && current.instanceId !== expectedInstanceId)) return;
    if (notice(sessionId)?.id !== noticeId) return;
    const list = notices(sessionId);
    const index = list.findIndex((item) => item.id === noticeId);
    if (index < 0 || list.length < 2) return;
    const target = list[(index + direction + list.length) % list.length];
    if (target) setSelection(sessionId, current.instanceId, target.id);
  }

  function isPending(sessionId: string | null, action: string): boolean {
    return !!sessionId && pendingCommands.has(`${sessionId}\u0000${action}`);
  }

  async function sendCommand(sessionId: string, command: string, expectedNoticeId?: string, requireSnapshot = true, expectedInstanceId?: string): Promise<void> {
    const requestClient = options.client();
    const before = snapshots.get(sessionId);
    if (!requestClient || !options.runtimeReady(sessionId) || (requireSnapshot && !before)) return;
    if (!before && !options.commandAvailable?.(sessionId)) return;
    if (expectedInstanceId && before?.snapshot.instanceId !== expectedInstanceId) return;
    if (expectedNoticeId && (selections.get(sessionId)?.noticeId !== expectedNoticeId
      || !activeNotices(before!.snapshot).some((item) => item.id === expectedNoticeId && noticeIsCurrent(item, Date.now())))) return;
    const key = `${sessionId}\u0000${command}`;
    if (pendingCommands.has(key)) return;
    const token = Symbol(key);
    commandTokens.set(key, token);
    const requestGeneration = lifecycleGeneration;
    pendingCommands = new Set(pendingCommands).add(key);
    try {
      await requestClient.prompt(sessionId, [{ type: "text", text: command }]);
      // Only the extension's next snapshot changes state. Command replies are not state.
    } catch (error) {
      if (requestGeneration === lifecycleGeneration && requestClient === options.client()
        && (!before || snapshots.get(sessionId)?.snapshot.instanceId === before.snapshot.instanceId)) options.reportError(error);
    } finally {
      if (commandTokens.get(key) === token) {
        commandTokens.delete(key);
        const next = new Set(pendingCommands);
        next.delete(key);
        pendingCommands = next;
      }
    }
  }

  function sendFeedback(sessionId: string, feedback: HeadsUpFeedback, noticeId: string, instanceId?: string): Promise<void> {
    return sendCommand(sessionId, `/heads-up ${feedback} ${noticeId}`, noticeId, true, instanceId);
  }

  function sendControl(sessionId: string, action: "on" | "off" | "check"): Promise<void> {
    return sendCommand(sessionId, `/heads-up ${action}`);
  }

  /** Ask a ready observer to publish state only; this cannot start inference or alter a draft. */
  function requestSnapshot(sessionId: string): Promise<void> {
    return sendCommand(sessionId, "/heads-up snapshot", undefined, false);
  }

  /** Fill only an empty, still-owned composer; attachments are never changed. */
  function discuss(
    sessionId: string,
    targetNotice: HeadsUpNotice,
    canInsert: () => boolean,
    getPromptText: () => string,
    getAttachments: () => readonly Attachment[],
    setPromptText: (text: string) => void,
    expectedInstanceId?: string,
  ): boolean {
    const current = snapshots.get(sessionId);
    const selected = selections.get(sessionId);
    const canonical = current && selected?.instanceId === current.snapshot.instanceId && selected.noticeId === targetNotice.id
      ? activeNotices(current.snapshot).find((item) => item.id === targetNotice.id)
      : undefined;
    if (!current?.snapshot.enabled || (expectedInstanceId && current.snapshot.instanceId !== expectedInstanceId) || !canonical || !noticeIsCurrent(canonical, Date.now())
      || !options.runtimeReady(sessionId) || !canInsert() || getPromptText() !== "" || getAttachments().length !== 0) return false;
    setPromptText(headsUpDiscussionDraft(canonical));
    return true;
  }

  function clearSession(sessionId: string): void {
    const current = snapshots.get(sessionId);
    if (current) markRetired(sessionId, current.snapshot.instanceId);
    snapshots.delete(sessionId);
    selections.delete(sessionId);
    selections = new Map(selections);
    lifecycleGeneration += 1;
    snapshots = new Map(snapshots);
    for (const key of commandTokens.keys()) if (key.startsWith(`${sessionId}\u0000`)) { commandTokens.delete(key); pendingCommands.delete(key); }
    pendingCommands = new Set(pendingCommands);
    scheduleExpiry();
  }

  function reset(): void {
    for (const [sessionId, { snapshot }] of snapshots) markRetired(sessionId, snapshot.instanceId);
    lifecycleGeneration += 1;
    snapshots = new Map();
    selections = new Map();
    pendingCommands = new Set();
    commandTokens.clear();
    if (expiryTimer !== undefined) clearTimeout(expiryTimer);
    expiryTimer = undefined;
  }

  return {
    get snapshots() { return snapshots; },
    get nowMs() { return nowMs; },
    get pendingCommands() { return pendingCommands; },
    handleSessionState,
    state,
    notice,
    notices,
    selectNotice,
    isPending,
    sendFeedback,
    sendControl,
    requestSnapshot,
    discuss,
    clearSession,
    reset,
  };
}

export type HeadsUpStore = ReturnType<typeof createHeadsUpStore>;
