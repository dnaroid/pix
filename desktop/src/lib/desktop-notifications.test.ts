import { describe, expect, it, vi } from "vitest";
import {
  createDesktopAgentNotificationCoordinator,
  createDesktopNotificationService,
} from "./desktop-notifications";

function notificationHarness(foreground = false) {
  const api = {
    isPermissionGranted: vi.fn(async () => true),
    requestPermission: vi.fn(async () => "granted" as NotificationPermission),
    sendNotification: vi.fn(async () => undefined),
    listenActivation: vi.fn(async (_handler: (sessionId: string | null) => void): Promise<() => void> => () => undefined),
    focusWindow: vi.fn(async () => undefined),
  };
  const service = createDesktopNotificationService({ isForeground: () => foreground, api });
  return { api, service };
}

describe("desktop native notifications", () => {
  it("suppresses native notifications while the window is foreground", async () => {
    const { api, service } = notificationHarness(true);

    await service.completed("session-1", "Build session");

    expect(api.isPermissionGranted).not.toHaveBeenCalled();
    expect(api.sendNotification).not.toHaveBeenCalled();
  });

  it("suppresses permission requests and delivery when notifications are disabled", async () => {
    const api = {
      isPermissionGranted: vi.fn(async () => true),
      requestPermission: vi.fn(async () => "granted" as NotificationPermission),
      sendNotification: vi.fn(async () => undefined),
      listenActivation: vi.fn(async (_handler: (sessionId: string | null) => void) => vi.fn()),
      focusWindow: vi.fn(async () => undefined),
    };
    const service = createDesktopNotificationService({
      isForeground: () => false,
      enabled: () => false,
      api,
    });

    await service.completed("session-1", "Build session");

    expect(api.isPermissionGranted).not.toHaveBeenCalled();
    expect(api.requestPermission).not.toHaveBeenCalled();
    expect(api.sendNotification).not.toHaveBeenCalled();
  });

  it("requests permission once and sends background notifications", async () => {
    const api = {
      isPermissionGranted: vi.fn(async () => false),
      requestPermission: vi.fn(async () => "granted" as NotificationPermission),
      sendNotification: vi.fn(async () => undefined),
      listenActivation: vi.fn(async (_handler: (sessionId: string | null) => void) => vi.fn()),
      focusWindow: vi.fn(async () => undefined),
    };
    const service = createDesktopNotificationService({ isForeground: () => false, api });

    await service.question("session-1", "Research", "Which branch should I use?");
    await service.completed("session-1", "Research");

    expect(api.isPermissionGranted).toHaveBeenCalledTimes(1);
    expect(api.requestPermission).toHaveBeenCalledTimes(1);
    expect(api.sendNotification).toHaveBeenNthCalledWith(1, {
      title: "Pix — Question",
      body: "Research: Which branch should I use?",
      sessionId: "session-1",
    });
    expect(api.sendNotification).toHaveBeenNthCalledWith(2, {
      title: "Pix — Completed",
      body: "Research",
      sessionId: "session-1",
    });
  });

  it("focuses the owning window and activates the exact session when clicked", async () => {
    const { api, service } = notificationHarness(false);
    const activateSession = vi.fn(async () => undefined);
    service.setActivationHandler(activateSession);

    await service.question("session-2", "Research", "Need input");
    const onClick = api.listenActivation.mock.calls[0]?.[0];
    expect(onClick).toEqual(expect.any(Function));

    onClick?.("session-2");

    await vi.waitFor(() => expect(api.focusWindow).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(activateSession).toHaveBeenCalledWith("session-2"));
  });

  it("routes older notifications by their captured session, not the latest delivery", async () => {
    const { api, service } = notificationHarness();
    const activateSession = vi.fn();
    service.setActivationHandler(activateSession);
    await service.completed("first", "First");
    await service.completed("second", "Second");
    expect(api.listenActivation).toHaveBeenCalledTimes(1);
    api.listenActivation.mock.calls[0]?.[0]("first");
    await vi.waitFor(() => expect(activateSession).toHaveBeenCalledWith("first"));
    expect(activateSession).not.toHaveBeenCalledWith("second");
  });

  it("installs the activation listener before native delivery", async () => {
    const { api, service } = notificationHarness();
    let subscribed!: (unlisten: () => void) => void;
    api.listenActivation.mockImplementation(() => new Promise((resolve) => subscribed = resolve));
    const sending = service.completed("first", "First");
    await vi.waitFor(() => expect(api.listenActivation).toHaveBeenCalledTimes(1));
    expect(api.sendNotification).not.toHaveBeenCalled();
    subscribed(vi.fn());
    await sending;
    expect(api.sendNotification).toHaveBeenCalledTimes(1);
  });

  it("suppresses delivery if the window foregrounds while subscription is pending", async () => {
    const { api } = notificationHarness();
    let foreground = false;
    let subscribed!: (unlisten: () => void) => void;
    api.listenActivation.mockImplementation(() => new Promise((resolve) => subscribed = resolve));
    const service = createDesktopNotificationService({ api, isForeground: () => foreground });
    const sending = service.completed("first", "First");
    await vi.waitFor(() => expect(api.listenActivation).toHaveBeenCalledTimes(1));
    foreground = true;
    subscribed(() => undefined);
    await sending;
    expect(api.sendNotification).not.toHaveBeenCalled();
    service.dispose();
  });

  it("retries a failed listener instead of delivering an unrouteable notification", async () => {
    const { api, service } = notificationHarness();
    api.listenActivation.mockRejectedValueOnce(new Error("host unavailable"));
    await service.completed("first", "First");
    expect(api.sendNotification).not.toHaveBeenCalled();
    await service.completed("second", "Second");
    expect(api.listenActivation).toHaveBeenCalledTimes(2);
    expect(api.sendNotification).toHaveBeenCalledWith({
      title: "Pix — Completed", body: "Second", sessionId: "second",
    });
  });

  it("releases a late subscription and drops delivery after teardown", async () => {
    const { api, service } = notificationHarness();
    const unlisten = vi.fn();
    const activateSession = vi.fn();
    let subscribed!: (unlisten: () => void) => void;
    api.listenActivation.mockImplementation(() => new Promise((resolve) => subscribed = resolve));
    service.setActivationHandler(activateSession);
    const sending = service.completed("first", "First");
    await vi.waitFor(() => expect(api.listenActivation).toHaveBeenCalledTimes(1));
    service.dispose();
    subscribed(unlisten);
    await sending;
    api.listenActivation.mock.calls[0]?.[0]("first");
    expect(unlisten).toHaveBeenCalledTimes(1);
    expect(api.sendNotification).not.toHaveBeenCalled();
    expect(api.focusWindow).not.toHaveBeenCalled();
    expect(activateSession).not.toHaveBeenCalled();
  });

  it("releases the listener on unmount and still navigates if focus fails", async () => {
    const { api, service } = notificationHarness();
    const unlisten = vi.fn();
    api.listenActivation.mockResolvedValue(unlisten);
    api.focusWindow.mockRejectedValue(new Error("focus unavailable"));
    const activateSession = vi.fn();
    service.setActivationHandler(activateSession);
    const stop = service.start();
    await service.completed("first", "First");
    api.listenActivation.mock.calls[0]?.[0]("first");
    await vi.waitFor(() => expect(activateSession).toHaveBeenCalledWith("first"));
    stop();
    stop();
    expect(unlisten).toHaveBeenCalledTimes(1);
  });

  it("sends a paused notification for a background session", async () => {
    const { api, service } = notificationHarness(false);

    await service.paused("session-3", "Long refactor");

    expect(api.sendNotification).toHaveBeenCalledWith({
      title: "Pix — Paused",
      body: "Long refactor",
      sessionId: "session-3",
    });
  });
});

describe("sound-only notifications", () => {
  function soundHarness(active = false) {
    const { api } = notificationHarness();
    const playPixSound = vi.fn(async () => undefined);
    let notificationsEnabled = true;
    let soundOnlyEnabled = true;
    const preferences = vi.fn(async () => ({ notificationsEnabled, soundOnlyEnabled }));
    const service = createDesktopNotificationService({
      api, preferences, playPixSound,
      isForeground: () => active,
      isActiveSession: (sessionId) => sessionId === "active",
    });
    return {
      api, service, playPixSound, preferences,
      disable: () => notificationsEnabled = false,
      native: () => soundOnlyEnabled = false,
    };
  }

  it("only plays sound without contacting macOS notifications or requiring permission", async () => {
    const h = soundHarness();
    await h.service.question("inactive", "Research", "Need approval");
    expect(h.playPixSound).toHaveBeenCalledTimes(1);
    expect(h.api.isPermissionGranted).not.toHaveBeenCalled();
    expect(h.api.requestPermission).not.toHaveBeenCalled();
    expect(h.api.sendNotification).not.toHaveBeenCalled();
  });

  it("suppresses sound for the currently visible session but not for another tab", async () => {
    const h = soundHarness(true);
    await h.service.completed("active", "Active");
    expect(h.preferences).not.toHaveBeenCalled();
    await h.service.completed("inactive", "Inactive");
    expect(h.playPixSound).toHaveBeenCalledTimes(1);
  });

  it("respects the master switch in both delivery modes", async () => {
    const h = soundHarness();
    h.disable();
    await h.service.error("inactive", "Task", "Failed");
    expect(h.playPixSound).not.toHaveBeenCalled();
    h.native();
    await h.service.completed("inactive", "Done");
    expect(h.api.sendNotification).not.toHaveBeenCalled();
    // Still disabled: neither delivery mechanism is active.
    expect(h.api.isPermissionGranted).not.toHaveBeenCalled();
  });

  it("switches back to native delivery without playing sound", async () => {
    const h = soundHarness();
    await h.service.completed("inactive", "First");
    h.native();
    await h.service.completed("inactive", "Second");
    expect(h.playPixSound).toHaveBeenCalledTimes(1);
    expect(h.api.sendNotification).toHaveBeenCalledWith({
      title: "Pix — Completed", body: "Second", sessionId: "inactive",
    });
  });

  it("drops sound when preferences resolve after disposal", async () => {
    const h = soundHarness();
    let resolve!: (value: { notificationsEnabled: boolean; soundOnlyEnabled: boolean }) => void;
    h.preferences.mockImplementationOnce(() => new Promise((done) => resolve = done));
    const pending = h.service.completed("inactive", "Late");
    await vi.waitFor(() => expect(h.preferences).toHaveBeenCalledTimes(1));
    h.service.dispose();
    resolve({ notificationsEnabled: true, soundOnlyEnabled: true });
    await pending;
    expect(h.playPixSound).not.toHaveBeenCalled();
  });

  it("does not send an old native notification when the preference changes during subscription", async () => {
    const h = soundHarness();
    h.native();
    let subscribed!: (unlisten: () => void) => void;
    h.api.listenActivation.mockImplementation(() => new Promise((done) => subscribed = done));
    const pending = h.service.completed("inactive", "Old");
    await vi.waitFor(() => expect(h.api.listenActivation).toHaveBeenCalledTimes(1));
    h.preferences.mockResolvedValue({ notificationsEnabled: true, soundOnlyEnabled: true });
    subscribed(vi.fn());
    await pending;
    expect(h.api.sendNotification).not.toHaveBeenCalled();
  });

  it("tolerates a failed audio cue without affecting agent work", async () => {
    const h = soundHarness();
    h.playPixSound.mockRejectedValue(new Error("device unavailable"));
    await expect(h.service.question(null, "Ask", " long\n".repeat(100))).resolves.toBeUndefined();
    expect(h.playPixSound).toHaveBeenCalledExactlyOnceWith();
    expect(h.api.sendNotification).not.toHaveBeenCalled();
  });
});

describe("desktop agent notification coordinator", () => {
  it("marks tray attention only after prompt, state and subagents are fully settled", () => {
    const { service } = notificationHarness(true);
    const attention = { mark: vi.fn(), clearSession: vi.fn(), reset: vi.fn() };
    let running = true;
    let state: "running" | "idle" = "running";
    let subagents = 1;
    const coordinator = createDesktopAgentNotificationCoordinator({
      notifications: service, sessionTitle: () => "Task", agentState: () => state,
      isPromptRunning: () => running, activeSubagents: () => subagents, attention,
    });
    coordinator.promptSettled("a", "end_turn");
    expect(attention.mark).not.toHaveBeenCalled();
    running = false;
    coordinator.sessionActivityChanged("a");
    expect(attention.mark).not.toHaveBeenCalled();
    state = "idle";
    coordinator.sessionActivityChanged("a");
    expect(attention.mark).not.toHaveBeenCalled();
    subagents = 0;
    coordinator.sessionActivityChanged("a");
    coordinator.sessionActivityChanged("a");
    expect(attention.mark.mock.calls).toEqual([["a"]]);
  });

  it("marks questions and errors independently of OS notification settings and permission", async () => {
    const { api } = notificationHarness();
    const service = createDesktopNotificationService({ api, enabled: () => false, isForeground: () => false });
    const attention = { mark: vi.fn(), clearSession: vi.fn(), reset: vi.fn() };
    const coordinator = createDesktopAgentNotificationCoordinator({
      notifications: service, sessionTitle: () => "Task", agentState: () => "idle",
      isPromptRunning: () => false, activeSubagents: () => 0, attention,
    });
    coordinator.needsInput("a", "Approve tool");
    coordinator.needsInput(null, "Global question");
    coordinator.promptError("b", new Error("provider"));
    coordinator.promptSettled("c", "refusal");
    coordinator.promptSettled("d", "end_turn");
    coordinator.promptSettled("e", "cancelled");
    coordinator.paused("e");
    await Promise.resolve();
    expect(attention.mark.mock.calls).toEqual([["a"], [null], ["b"], ["c"], ["d"]]);
    expect(api.isPermissionGranted).not.toHaveBeenCalled();
    expect(api.sendNotification).not.toHaveBeenCalled();
    coordinator.promptStarted("a");
    coordinator.clearSession("b");
    coordinator.reset();
    expect(attention.clearSession.mock.calls).toEqual([["a"], ["b"]]);
    expect(attention.reset).toHaveBeenCalledTimes(1);
  });

  it("waits for active subagents before reporting successful completion", async () => {
    const { api, service } = notificationHarness(false);
    let activeSubagents = 1;
    const onCompleted = vi.fn();
    const coordinator = createDesktopAgentNotificationCoordinator({
      notifications: service,
      sessionTitle: () => "Background task",
      agentState: () => "idle",
      isPromptRunning: () => false,
      activeSubagents: () => activeSubagents,
      onCompleted,
    });

    coordinator.promptSettled("session-1", "end_turn");
    await Promise.resolve();
    expect(api.sendNotification).not.toHaveBeenCalled();
    expect(onCompleted).not.toHaveBeenCalled();

    activeSubagents = 0;
    coordinator.sessionActivityChanged("session-1");
    await vi.waitFor(() => expect(api.sendNotification).toHaveBeenCalledTimes(1));
    expect(onCompleted).toHaveBeenCalledWith("session-1");
    expect(api.sendNotification).toHaveBeenCalledWith({
      title: "Pix — Completed",
      body: "Background task",
      sessionId: "session-1",
    });
  });

  it("suppresses cancellation and turns abnormal stop reasons into errors", async () => {
    const { api, service } = notificationHarness(false);
    const coordinator = createDesktopAgentNotificationCoordinator({
      notifications: service,
      sessionTitle: () => "Limits",
      agentState: () => "idle",
      isPromptRunning: () => false,
      activeSubagents: () => 0,
    });

    coordinator.promptSettled("session-1", "cancelled");
    coordinator.promptSettled("session-1", "max_turn_requests");

    await vi.waitFor(() => expect(api.sendNotification).toHaveBeenCalledTimes(1));
    expect(api.sendNotification).toHaveBeenCalledWith({
      title: "Pix — Error",
      body: "Limits: Agent stopped after reaching the turn/request limit.",
      sessionId: "session-1",
    });
  });

  it("does not mislabel a provider failure as a model refusal in background notifications", async () => {
    const { api, service } = notificationHarness(false);
    const coordinator = createDesktopAgentNotificationCoordinator({
      notifications: service,
      sessionTitle: () => "Design session",
      agentState: () => "idle",
      isPromptRunning: () => false,
      activeSubagents: () => 0,
    });
    coordinator.promptSettled("session-error", "refusal");
    await vi.waitFor(() => expect(api.sendNotification).toHaveBeenCalledTimes(1));
    expect(api.sendNotification).toHaveBeenCalledWith({
      title: "Pix — Error",
      body: "Design session: Agent stopped before completing the request. Check the conversation for details.",
      sessionId: "session-error",
    });
  });

  it("drops a deferred completion when new work starts", async () => {
    const { api, service } = notificationHarness(false);
    let activeSubagents = 1;
    const onCompleted = vi.fn();
    const coordinator = createDesktopAgentNotificationCoordinator({
      notifications: service,
      sessionTitle: () => "Queued work",
      agentState: () => "idle",
      isPromptRunning: () => false,
      activeSubagents: () => activeSubagents,
      onCompleted,
    });

    coordinator.promptSettled("session-1", "end_turn");
    coordinator.promptStarted("session-1");
    activeSubagents = 0;
    coordinator.sessionActivityChanged("session-1");
    await Promise.resolve();

    expect(api.sendNotification).not.toHaveBeenCalled();
    expect(onCompleted).not.toHaveBeenCalled();
  });
});
