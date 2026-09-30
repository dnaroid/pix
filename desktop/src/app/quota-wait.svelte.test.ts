import { describe, expect, it, vi } from "vitest";
import type { AcpClient } from "../lib/acp-client";
import type { SessionStateNotification } from "../lib/session-state";
import { createQuotaWaitStore } from "./quota-wait.svelte";
import type { QuotaWaitState } from "../lib/quota-wait";

function waitState(overrides: Partial<QuotaWaitState> = {}): QuotaWaitState {
  return {
    version: 1,
    modelKey: "anthropic/claude",
    reason: "Usage limit reached",
    window: "hourly",
    resetAt: 60_000,
    nextCheckAt: 60_000,
    autoResume: true,
    phase: "waiting",
    attempt: 0,
    ...overrides,
  };
}

function notification(sessionId: string, state: QuotaWaitState | null): SessionStateNotification {
  return { sessionId, channel: "quota-wait", data: { state } };
}

function createStore(overrides: {
  client?: AcpClient | null;
  runtimeReady?: (sessionId: string) => boolean;
  reportError?: (error: unknown) => void;
} = {}) {
  const client = overrides.client !== undefined
    ? overrides.client
    : ({ prompt: vi.fn(async () => {}) } as unknown as AcpClient);
  const runtimeReady = overrides.runtimeReady ?? (() => true);
  const reportError = overrides.reportError ?? (() => {});
  const store = createQuotaWaitStore({
    client: () => client,
    runtimeReady,
    reportError,
  });
  return { store, client, runtimeReady, reportError };
}

describe("createQuotaWaitStore pushed state", () => {
  it("tracks wait state per session and reports waiting", () => {
    const { store } = createStore();
    expect(store.handleSessionState(notification("session-1", waitState()))).toBe(true);
    expect(store.waiting("session-1")).toBe(true);
    expect(store.waiting("session-2")).toBe(false);
    expect(store.popupVisible("session-1")).toBeDefined();
    expect(store.popupVisible("session-2")).toBeUndefined();
    expect(store.indicator("session-1")).toBeDefined();
  });

  it("hide suppresses the popup but keeps the indicator; reopen restores it", () => {
    const { store } = createStore();
    store.handleSessionState(notification("session-1", waitState()));
    store.hide("session-1");
    expect(store.popupVisible("session-1")).toBeUndefined();
    expect(store.indicator("session-1")).toBeDefined();
    expect(store.waiting("session-1")).toBe(true);
    store.reopen("session-1");
    expect(store.popupVisible("session-1")).toBeDefined();
  });

  it("countdown ticks keep a hidden popup hidden", () => {
    const { store } = createStore();
    store.handleSessionState(notification("session-1", waitState()));
    store.hide("session-1");
    store.handleSessionState(notification("session-1", waitState({ nextCheckAt: 120_000, attempt: 2 })));
    expect(store.popupVisible("session-1")).toBeUndefined();
    expect(store.indicator("session-1")).toBeDefined();
  });

  it("a new wait with a different identity reopens a hidden popup", () => {
    const { store } = createStore();
    store.handleSessionState(notification("session-1", waitState()));
    store.hide("session-1");
    store.handleSessionState(notification("session-1", waitState({
      reason: "Scheduled continuation",
      window: "unknown",
      mode: "timer",
      notBefore: 120_000,
    })));
    expect(store.popupVisible("session-1")).toBeDefined();
  });

  it("a wait after a clear reopens the popup", () => {
    const { store } = createStore();
    store.handleSessionState(notification("session-1", waitState()));
    store.hide("session-1");
    store.handleSessionState(notification("session-1", null));
    store.handleSessionState(notification("session-1", waitState()));
    expect(store.popupVisible("session-1")).toBeDefined();
  });

  it("clearing state removes wait, hidden flag, and stops blocking drain", () => {
    const { store } = createStore();
    store.handleSessionState(notification("session-1", waitState()));
    store.hide("session-1");
    store.handleSessionState(notification("session-1", null));
    expect(store.waiting("session-1")).toBe(false);
    expect(store.popupVisible("session-1")).toBeUndefined();
    expect(store.indicator("session-1")).toBeUndefined();
    store.reopen("session-1");
    expect(store.popupVisible("session-1")).toBeUndefined();
  });

  it("ignores other session-state channels", () => {
    const { store } = createStore();
    expect(store.handleSessionState({ sessionId: "session-1", channel: "model-usage", data: {} })).toBe(false);
    expect(store.waiting("session-1")).toBe(false);
  });

  it("clearSession drops all per-session state", () => {
    const { store } = createStore();
    store.handleSessionState(notification("session-1", waitState()));
    store.openSchedule("session-1");
    store.clearSession("session-1");
    expect(store.waiting("session-1")).toBe(false);
    expect(store.scheduleVisible("session-1")).toBe(false);
  });

  it("reset drops state for every session", () => {
    const { store } = createStore();
    store.handleSessionState(notification("session-1", waitState()));
    store.openSchedule("session-2");
    store.reset();
    expect(store.waiting("session-1")).toBe(false);
    expect(store.scheduleVisible("session-2")).toBe(false);
  });
});

describe("createQuotaWaitStore schedule setup", () => {
  it("opening and cancelling the setup popup changes no session state", () => {
    const { store } = createStore();
    store.openSchedule("session-1");
    expect(store.scheduleVisible("session-1")).toBe(true);
    expect(store.scheduleVisible("session-2")).toBe(false);
    expect(store.waiting("session-1")).toBe(false);
    expect(store.popupVisible("session-1")).toBeUndefined();
    expect(store.statesBySession.size).toBe(0);
    store.closeSchedule("session-1");
    expect(store.scheduleVisible("session-1")).toBe(false);
    expect(store.statesBySession.size).toBe(0);
  });

  it("an incoming wait supersedes the open setup popup", () => {
    const { store } = createStore();
    store.openSchedule("session-1");
    store.handleSessionState(notification("session-1", waitState()));
    expect(store.scheduleVisible("session-1")).toBe(false);
    expect(store.waiting("session-1")).toBe(true);
  });

  it("submitting sends the exact /wait command out-of-band and closes the popup", async () => {
    const { store, client } = createStore();
    const prompt = vi.mocked(client!.prompt);
    store.openSchedule("session-1");
    await store.submitSchedule("session-1", "/wait until 2026-01-01T10:30:00.000Z");
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(prompt).toHaveBeenCalledWith("session-1", [{ type: "text", text: "/wait until 2026-01-01T10:30:00.000Z" }]);
    expect(store.scheduleVisible("session-1")).toBe(false);
  });

  it("submitting duration and usage-reset commands verbatim", async () => {
    const { store, client } = createStore();
    const prompt = vi.mocked(client!.prompt);
    await store.submitSchedule("session-1", "/wait 1h20m");
    await store.submitSchedule("session-1", "/wait usage-reset");
    expect(prompt).toHaveBeenNthCalledWith(1, "session-1", [{ type: "text", text: "/wait 1h20m" }]);
    expect(prompt).toHaveBeenNthCalledWith(2, "session-1", [{ type: "text", text: "/wait usage-reset" }]);
  });

  it("keeps the setup popup open when the runtime is not ready", async () => {
    const { store, client } = createStore({ runtimeReady: () => false });
    const prompt = vi.mocked(client!.prompt);
    store.openSchedule("session-1");
    await store.submitSchedule("session-1", "/wait usage-reset");
    expect(prompt).not.toHaveBeenCalled();
    expect(store.scheduleVisible("session-1")).toBe(true);
  });

  it("keeps the setup popup open without a client", async () => {
    const { store } = createStore({ client: null });
    store.openSchedule("session-1");
    await store.submitSchedule("session-1", "/wait usage-reset");
    expect(store.scheduleVisible("session-1")).toBe(true);
  });

  it("reports send failures and still closes the popup", async () => {
    const reportError = vi.fn();
    const failing = { prompt: vi.fn(async () => { throw new Error("boom"); }) } as unknown as AcpClient;
    const { store } = createStore({ client: failing, reportError });
    store.openSchedule("session-1");
    await store.submitSchedule("session-1", "/wait usage-reset");
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(store.scheduleVisible("session-1")).toBe(false);
  });
});

describe("createQuotaWaitStore actions", () => {
  it("sends /wait retry and /wait cancel", async () => {
    const { store, client } = createStore();
    const prompt = vi.mocked(client!.prompt);
    await store.sendAction("session-1", "retry");
    await store.sendAction("session-1", "cancel");
    expect(prompt).toHaveBeenNthCalledWith(1, "session-1", [{ type: "text", text: "/wait retry" }]);
    expect(prompt).toHaveBeenNthCalledWith(2, "session-1", [{ type: "text", text: "/wait cancel" }]);
  });

  it("suppresses duplicate concurrent sends per session", async () => {
    let release!: () => void;
    const client = {
      prompt: vi.fn(() => new Promise<void>((resolve) => { release = resolve; })),
    } as unknown as AcpClient;
    const { store } = createStore({ client });
    const first = store.sendAction("session-1", "retry");
    const second = store.sendAction("session-1", "retry");
    release();
    await Promise.all([first, second]);
    expect(vi.mocked(client.prompt)).toHaveBeenCalledTimes(1);
  });

  it("does not send without a client or ready runtime", async () => {
    const { store: noClient } = createStore({ client: null });
    await noClient.sendAction("session-1", "retry");
    const { store: notReady, client } = createStore({ runtimeReady: () => false });
    await notReady.sendAction("session-1", "retry");
    expect(vi.mocked(client!.prompt)).not.toHaveBeenCalled();
  });
});
