import type { SessionConfigOption } from "@agentclientprotocol/sdk";
import type { AcpClient } from "../lib/acp-client";

export type SessionRuntimeStoreOptions = {
  client: () => AcpClient | null;
  workspace: () => string;
  activeSessionId: () => string | null;
  setActiveReady: (ready: boolean) => void;
  setActiveConfigOptions: (options: SessionConfigOption[]) => void;
  refreshQueueState: (sessionId: string) => void | Promise<void>;
  reportError: (error: unknown) => void;
};
