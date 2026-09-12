import type {
  AvailableCommand,
  SessionConfigOption,
  SessionInfo,
  SessionNotification,
} from "@agentclientprotocol/sdk";

type SessionMetadataOptions = {
  updateSessionInfo: (
    sessionId: string,
    patch: Pick<SessionInfo, "title" | "updatedAt">,
  ) => void;
  setConfigOptions: (sessionId: string, options: SessionConfigOption[]) => void;
  activeSessionId: () => string | null;
  setActiveConfigOptions: (options: SessionConfigOption[]) => void;
};

export function createSessionMetadataStore(options: SessionMetadataOptions) {
  let slashCommandsBySession = $state<Map<string, AvailableCommand[]>>(new Map());

  function handle(notification: SessionNotification): boolean {
    const update = notification.update;
    if (update.sessionUpdate === "available_commands_update") {
      const next = new Map(slashCommandsBySession);
      next.set(notification.sessionId, update.availableCommands);
      slashCommandsBySession = next;
      return true;
    }
    if (update.sessionUpdate === "session_info_update") {
      options.updateSessionInfo(notification.sessionId, {
        ...(update.title !== undefined ? { title: update.title } : {}),
        ...(update.updatedAt !== undefined ? { updatedAt: update.updatedAt } : {}),
      });
      return true;
    }
    if (update.sessionUpdate === "config_option_update") {
      options.setConfigOptions(notification.sessionId, update.configOptions);
      if (notification.sessionId === options.activeSessionId()) {
        options.setActiveConfigOptions(update.configOptions);
      }
      return true;
    }
    return false;
  }

  function clear(sessionId: string): void {
    if (!slashCommandsBySession.has(sessionId)) return;
    const next = new Map(slashCommandsBySession);
    next.delete(sessionId);
    slashCommandsBySession = next;
  }

  function reset(): void {
    slashCommandsBySession = new Map();
  }

  return {
    get slashCommandsBySession() { return slashCommandsBySession; },
    handle,
    clear,
    reset,
  };
}
