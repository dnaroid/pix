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

describe("desktop agent notification coordinator", () => {
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
