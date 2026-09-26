import { describe, expect, it } from "vitest";
import type { SessionConfigOption, SessionNotification } from "@agentclientprotocol/sdk";
import { createSessionMetadataStore } from "./session-metadata.svelte";

function thoughtLevelOption(currentValue: string): SessionConfigOption {
  return {
    type: "select",
    id: "thought_level",
    name: "Thought level",
    category: "thought_level",
    currentValue,
    options: [
      { value: "off", name: "off" },
      { value: "medium", name: "medium" },
      { value: "high", name: "high" },
    ],
  };
}

function configOptionUpdate(sessionId: string, currentValue: string): SessionNotification {
  return {
    sessionId,
    update: {
      sessionUpdate: "config_option_update",
      configOptions: [thoughtLevelOption(currentValue)],
    },
  } as SessionNotification;
}

function createStore(activeSessionId: () => string | null) {
  const runtimeOptions = new Map<string, SessionConfigOption[]>();
  let activeOptions: SessionConfigOption[] | undefined;
  const store = createSessionMetadataStore({
    updateSessionInfo: () => {},
    setConfigOptions: (sessionId, options) => {
      runtimeOptions.set(sessionId, options);
    },
    activeSessionId,
    setActiveConfigOptions: (options) => {
      activeOptions = options;
    },
  });
  return { store, runtimeOptions, activeOptions: () => activeOptions };
}

describe("session metadata store", () => {
  it("applies a config_option_update to the runtime map and the active session", () => {
    const { store, runtimeOptions, activeOptions } = createStore(() => "session-a");

    const handled = store.handle(configOptionUpdate("session-a", "high"));

    expect(handled).toBe(true);
    expect(runtimeOptions.get("session-a")?.[0]).toMatchObject({ id: "thought_level", currentValue: "high" });
    expect(activeOptions()?.[0]).toMatchObject({ id: "thought_level", currentValue: "high" });
  });

  it("applies a config_option_update for a background session only to the runtime map", () => {
    const { store, runtimeOptions, activeOptions } = createStore(() => "session-a");

    const handled = store.handle(configOptionUpdate("session-b", "high"));

    expect(handled).toBe(true);
    expect(runtimeOptions.get("session-b")?.[0]).toMatchObject({ id: "thought_level", currentValue: "high" });
    expect(activeOptions()).toBeUndefined();
  });
});
