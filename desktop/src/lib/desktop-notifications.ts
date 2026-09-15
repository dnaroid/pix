import type { StopReason } from "@agentclientprotocol/sdk";
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";
import type { AgentControlState } from "./agent-control";

type NativeNotificationApi = {
  isPermissionGranted: () => Promise<boolean>;
  requestPermission: () => Promise<NotificationPermission>;
  sendNotification: (options: { title: string; body?: string }) => void;
};

type DesktopNotificationServiceOptions = {
  isForeground?: () => boolean;
  api?: NativeNotificationApi;
};

export type DesktopNotificationService = ReturnType<typeof createDesktopNotificationService>;

const NATIVE_NOTIFICATION_API: NativeNotificationApi = {
  isPermissionGranted,
  requestPermission,
  sendNotification,
};

export function desktopWindowForeground(): boolean {
  return document.visibilityState === "visible" && document.hasFocus();
}

function compactBody(value: string, maxLength = 240): string {
  const normalized = value.replace(/\s+/gu, " ").trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

export function createDesktopNotificationService(options: DesktopNotificationServiceOptions = {}) {
  const api = options.api ?? NATIVE_NOTIFICATION_API;
  const isForeground = options.isForeground ?? desktopWindowForeground;
  let permissionGranted: boolean | undefined;
  let permissionRequest: Promise<boolean> | null = null;

  async function ensurePermission(): Promise<boolean> {
    if (permissionGranted !== undefined) return permissionGranted;
    if (permissionRequest) return permissionRequest;
    permissionRequest = (async () => {
      try {
        if (await api.isPermissionGranted()) return true;
        return (await api.requestPermission()) === "granted";
      } catch {
        return false;
      }
    })().then((granted) => {
      permissionGranted = granted;
      permissionRequest = null;
      return granted;
    });
    return permissionRequest;
  }

  async function notify(title: string, body: string): Promise<void> {
    if (isForeground()) return;
    if (!(await ensurePermission()) || isForeground()) return;
    try {
      api.sendNotification({ title, body: compactBody(body) });
    } catch {
      // Native notifications are best effort and must never fail the agent flow.
    }
  }

  return {
    completed(sessionTitle: string): Promise<void> {
      return notify("Pix — Completed", sessionTitle);
    },
    question(sessionTitle: string, message: string): Promise<void> {
      return notify("Pix — Question", `${sessionTitle}: ${message}`);
    },
    error(sessionTitle: string, message: string): Promise<void> {
      return notify("Pix — Error", `${sessionTitle}: ${message}`);
    },
  };
}

type DesktopAgentNotificationCoordinatorOptions = {
  notifications: DesktopNotificationService;
  sessionTitle: (sessionId: string) => string | undefined;
  agentState: (sessionId: string) => AgentControlState;
  isPromptRunning: (sessionId: string) => boolean;
  activeSubagents: (sessionId: string) => number;
  onCompleted?: (sessionId: string) => void;
};

function stopReasonMessage(reason: Exclude<StopReason, "end_turn" | "cancelled">): string {
  switch (reason) {
    case "max_tokens":
      return "Agent stopped after reaching the model token limit.";
    case "max_turn_requests":
      return "Agent stopped after reaching the turn/request limit.";
    case "refusal":
      return "Agent stopped because the model refused the request.";
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createDesktopAgentNotificationCoordinator(options: DesktopAgentNotificationCoordinatorOptions) {
  const pendingCompletions = new Set<string>();

  function title(sessionId: string | null): string {
    if (!sessionId) return "Pix Desktop";
    return options.sessionTitle(sessionId)?.trim() || "Untitled conversation";
  }

  function flushCompletion(sessionId: string): void {
    if (!pendingCompletions.has(sessionId)) return;
    if (options.isPromptRunning(sessionId)) return;
    if (options.agentState(sessionId) !== "idle") return;
    if (options.activeSubagents(sessionId) > 0) return;
    pendingCompletions.delete(sessionId);
    try {
      options.onCompleted?.(sessionId);
    } catch {
      // In-app attention chrome is best effort and must not block native notification delivery.
    }
    void options.notifications.completed(title(sessionId));
  }

  function promptStarted(sessionId: string): void {
    pendingCompletions.delete(sessionId);
  }

  function promptSettled(sessionId: string, stopReason: StopReason): void {
    pendingCompletions.delete(sessionId);
    if (stopReason === "cancelled") return;
    if (stopReason !== "end_turn") {
      void options.notifications.error(title(sessionId), stopReasonMessage(stopReason));
      return;
    }
    pendingCompletions.add(sessionId);
    flushCompletion(sessionId);
  }

  function promptError(sessionId: string, error: unknown): void {
    pendingCompletions.delete(sessionId);
    void options.notifications.error(title(sessionId), errorMessage(error));
  }

  function needsInput(sessionId: string | null, message: string): void {
    void options.notifications.question(title(sessionId), message || "Agent is waiting for your input.");
  }

  function sessionActivityChanged(sessionId: string): void {
    flushCompletion(sessionId);
  }

  function clearSession(sessionId: string): void {
    pendingCompletions.delete(sessionId);
  }

  function reset(): void {
    pendingCompletions.clear();
  }

  return {
    promptStarted,
    promptSettled,
    promptError,
    needsInput,
    sessionActivityChanged,
    clearSession,
    reset,
  };
}
