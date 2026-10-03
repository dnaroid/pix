import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearMocks, mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import { createDesktopNotificationService } from "./desktop-notifications";

const host = vi.hoisted(() => ({
  invoke: vi.fn<(command: string, args?: Record<string, unknown>) => unknown>(),
}));

vi.mock("@tauri-apps/plugin-notification", () => ({
  isPermissionGranted: async () => true,
  requestPermission: async () => "granted",
}));

describe("Desktop notification native transport", () => {
  beforeEach(() => {
    vi.stubGlobal("window", { crypto: globalThis.crypto });
    host.invoke.mockReset();
    host.invoke.mockImplementation((command) => command === "plugin:event|listen" ? 42 : undefined);
    // Keep the real Window/WebviewWindow/event APIs: mocking .listen hid the
    // incompatible target kinds between the native emitter and frontend.
    mockIPC((command, args) => host.invoke(command, args as Record<string, unknown> | undefined));
  });
  afterEach(() => {
    clearMocks();
    vi.unstubAllGlobals();
  });

  it.each(["main", "project-test"])("matches native WebviewWindow activation for %s", async (windowLabel) => {
    mockWindows(windowLabel);
    // Mirrors Tauri's fire-and-forget constructor: no EventTarget methods.
    const notification = vi.fn(function () { return {}; });
    vi.stubGlobal("Notification", notification);
    const service = createDesktopNotificationService({ isForeground: () => false });
    const activate = vi.fn();
    service.setActivationHandler(activate);
    try {
      await service.completed("older-session", "Older");
      await service.completed("newer-session", "Newer");
      expect(notification).not.toHaveBeenCalled();
      const listens = host.invoke.mock.calls.filter(([command]) => command === "plugin:event|listen");
      expect(listens).toHaveLength(1);
      expect(listens[0]?.[1]).toEqual({
        event: "desktop-notification-activated",
        target: { kind: "WebviewWindow", label: windowLabel },
        handler: expect.any(Number),
      });
      expect(host.invoke).toHaveBeenCalledWith("desktop_send_notification", {
        title: "Pix — Completed", body: "Older", sessionId: "older-session",
      });
      const internals = (window as unknown as {
        __TAURI_INTERNALS__: { runCallback: (id: number, event: unknown) => void };
      }).__TAURI_INTERNALS__;
      internals.runCallback(listens[0]![1]!.handler as number, {
        event: "desktop-notification-activated", id: 42, payload: { sessionId: "older-session" },
      });
      await vi.waitFor(() => expect(activate).toHaveBeenCalledWith("older-session"));
      for (const command of ["unminimize", "show", "set_focus"]) {
        expect(host.invoke).toHaveBeenCalledWith(`plugin:window|${command}`, { label: windowLabel });
      }
      expect(activate).not.toHaveBeenCalledWith("newer-session");
    } finally {
      service.dispose();
    }
    await vi.waitFor(() => expect(host.invoke).toHaveBeenCalledWith("plugin:event|unlisten", {
      event: "desktop-notification-activated", eventId: 42,
    }));
  });
});
