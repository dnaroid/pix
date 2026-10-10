import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionConfigOption } from "@agentclientprotocol/sdk";
import { modelThinkingConfigState } from "../lib/model-thinking";
import { sessionTabModelDisplayOptions } from "../lib/session-tab-model";
import { createSessionTabsState } from "./session-tabs-state.svelte";
import { createDesktopStatusBarViewModel } from "./desktop-status-bar-view-model.svelte";

type Options = Parameters<typeof createDesktopStatusBarViewModel>[0];

function setup() {
  let sessionId: string | null = null;
  let workspace = "/project";
  let ready = false;
  let draft = false;
  let config: SessionConfigOption[] = [];
  const modelConfig = { pickerOpen: false, draftDisplayConfigOptions: [] as SessionConfigOption[] };
  const tabs = createSessionTabsState();
  const displayedConfigOptions = () => config;
  const view = createDesktopStatusBarViewModel({
    status: () => "starting", displayedConfigOptions, workspace: () => workspace, tabs,
    changingConfig: () => null, promptRunning: () => false, canUseSession: () => true,
    sessionHistoryLoading: () => false, draftSessionTabActive: () => draft, draftConfigAvailable: () => true,
    activeSessionRuntimeReady: () => ready, activeSessionId: () => sessionId,
    sessionActivity: () => ({}), sessionSubagentSnapshot: () => undefined, sessionTodoSnapshot: () => undefined,
    sessionNeedsInput: () => false, canClearTodos: () => false,
    runtime: { statuses: new Map(), sessionUsageBySession: new Map(), sessionUsageRefreshing: new Set(),
      sessionUsageFailed: new Set(), claudeLimitsRefreshing: new Set(), claudeLimitsFailed: new Set() },
    modelConfig, sessionCoordinator: {},
    quotaWait: { indicator: () => undefined, nowMs: 0 },
    headsUp: { state: () => undefined, isPending: () => false }, openObserverSettings: vi.fn(),
  } as unknown as Options);
  return {
    tabs, view, displayedConfigOptions, modelConfig,
    setSession: (value: string | null) => sessionId = value,
    setWorkspace: (value: string) => workspace = value,
    setReady: (value: boolean) => ready = value,
    setDraft: (value: boolean) => draft = value,
    setConfig: (value: SessionConfigOption[]) => config = value,
  };
}

const model = { modelRef: "pi-claude-code-provider/sonnet", modelName: "Sonnet", thinking: "high" };

describe("last-known status-bar model", () => {
  beforeEach(() => vi.stubGlobal("localStorage", { setItem: vi.fn() }));
  afterEach(() => vi.unstubAllGlobals());

  it("shows draft defaults immediately but keeps configuration disabled until live draft config arrives", () => {
    const state = setup();
    state.setDraft(true);
    state.modelConfig.draftDisplayConfigOptions = sessionTabModelDisplayOptions(model);
    expect(modelThinkingConfigState(state.view.props.configOptions).currentModel?.name).toBe("Sonnet");
    expect(state.view.props.canConfigure).toBe(false);
    expect(state.view.props.runtimeStatus).toBeUndefined(); // Context renders an empty 0% scale
    expect(state.view.props.sessionUsageAvailable).toBe(false);
    expect(state.view.props.claudeCodeRoute).toBe(false);
    expect(state.displayedConfigOptions()).toEqual([]);
    state.setConfig(sessionTabModelDisplayOptions({ ...model, modelName: "Fresh", thinking: "low" }));
    expect(modelThinkingConfigState(state.view.props.configOptions).currentModel?.name).toBe("Fresh");
    expect(state.view.props.canConfigure).toBe(true);
  });

  it("shows the saved active tab before activation, disabled and without contaminating runtime/route options", () => {
    const state = setup();
    expect(modelThinkingConfigState(state.view.props.configOptions).currentModel).toBeUndefined();
    state.tabs.setSessionTabIds(new Map([["/project", ["first", "active"]]]));
    state.tabs.setActiveSessionIds(new Map([["/project", "active"]]));
    state.tabs.models.restore(new Map([["/project", new Map([["active", model]])]]));
    expect(modelThinkingConfigState(state.view.props.configOptions).currentModel?.ref).toBe(model.modelRef);
    expect(modelThinkingConfigState(state.view.props.configOptions).currentThinking).toBe("high");
    expect(state.view.props.canConfigure).toBe(false);
    expect(state.view.props.claudeCodeRoute).toBe(false);
    expect(state.displayedConfigOptions()).toEqual([]);
    state.setSession("active");
    state.setConfig(sessionTabModelDisplayOptions({ ...model, modelRef: "other/new", modelName: "New", thinking: "low" }));
    expect(modelThinkingConfigState(state.view.props.configOptions).currentModel?.ref).toBe("other/new");
    expect(state.view.props.canConfigure).toBe(false);
    state.setReady(true);
    expect(state.view.props.canConfigure).toBe(true);
    state.setConfig([]);
    expect(modelThinkingConfigState(state.view.props.configOptions).currentModel).toBeUndefined();
  });

  it("isolates sessions, projects and drafts and never resurrects a closed saved active pointer", () => {
    const state = setup();
    state.tabs.setSessionTabIds(new Map([["/project", ["a", "b"]]]));
    state.tabs.setActiveSessionIds(new Map([["/project", "closed"]]));
    state.tabs.models.restore(new Map([["/project", new Map([
      ["a", model], ["b", { ...model, thinking: "off" }], ["closed", { ...model, modelName: "Closed" }],
    ])]]));
    expect(modelThinkingConfigState(state.view.props.configOptions).currentModel?.name).toBe("Sonnet");
    state.setSession("b");
    expect(modelThinkingConfigState(state.view.props.configOptions).currentThinking).toBe("off");
    state.setSession("missing");
    expect(state.view.props.configOptions).toEqual([]);
    state.setSession("a");
    state.setWorkspace("/other");
    expect(state.view.props.configOptions).toEqual([]);
    state.setWorkspace("/project");
    state.setDraft(true);
    expect(state.view.props.configOptions).toEqual([]);
    state.setConfig(sessionTabModelDisplayOptions({ ...model, thinking: "low" }));
    expect(modelThinkingConfigState(state.view.props.configOptions).currentThinking).toBe("low");
  });
});
