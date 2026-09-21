import type { SessionConfigOption } from "@agentclientprotocol/sdk";
import type { AcpClient } from "../lib/acp-client";
import type { createModelPreferencesStore } from "./model-preferences.svelte";
import type { createSessionRuntimeStore } from "./session-runtime.svelte";

type ModelPreferencesStore = ReturnType<typeof createModelPreferencesStore>;
type SessionRuntimeStore = ReturnType<typeof createSessionRuntimeStore>;

export type ModelConfigOptions = {
  client: () => AcpClient | null;
  workspace: () => string;
  statusReady: () => boolean;
  activeSessionId: () => string | null;
  activeSessionRuntimeReady: () => boolean;
  activeConfigOptions: () => SessionConfigOption[];
  setActiveConfigOptions: (options: SessionConfigOption[]) => void;
  draftSessionTabOpen: () => boolean;
  draftSessionTabActive: () => boolean;
  openDraftSessionTab: () => Promise<void>;
  operationRunning: () => boolean;
  changingConfig: () => string | null;
  closeCommandPicker: () => void;
  reloadResources: (options?: { echo?: boolean }) => Promise<void>;
  preferences: ModelPreferencesStore;
  runtime: SessionRuntimeStore;
  reportError: (error: unknown) => void;
};
