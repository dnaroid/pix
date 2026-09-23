import { describe, expect, it, vi } from "vitest";
import {
  createDesktopAgentNotificationCoordinator,
  createDesktopNotificationService,
} from "./desktop-notifications";

function notificationHarness(foreground = false) {
  const api = {
    isPermissionGranted: vi.fn(async () => true),
    requestPermission: vi.fn(async () => "granted" as NotificationPermission),
    sendNotification: vi.fn(),
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

  it("requests permission once and sends background notifications", async () => {
    const api = {
      isPermissionGranted: vi.fn(async () => false),
      requestPermission: vi.fn(async () => "granted" as NotificationPermission),
      sendNotification: vi.fn(),
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
    }, expect.any(Function));
    expect(api.sendNotification).toHaveBeenNthCalledWith(2, {
      title: "Pix — Completed",
      body: "Research",
    }, expect.any(Function));
  });

  it("focuses the owning window and activates the exact session when clicked", async () => {
    const { api, service } = notificationHarness(false);
    const activateSession = vi.fn(async () => undefined);
    service.setActivationHandler(activateSession);

    await service.question("session-2", "Research", "Need input");
    const onClick = api.sendNotification.mock.calls[0]?.[1];
    expect(onClick).toEqual(expect.any(Function));

    onClick?.();

    await vi.waitFor(() => expect(api.focusWindow).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(activateSession).toHaveBeenCalledWith("session-2"));
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
    }, expect.any(Function));
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
    }, expect.any(Function));
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
