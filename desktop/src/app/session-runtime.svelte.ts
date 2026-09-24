import { createSessionRuntimeConfigState } from "./session-runtime-config.svelte";
import { createSessionRuntimeLoading } from "./session-runtime-loading";
import type { SessionRuntimeStoreOptions } from "./session-runtime-options";
import { createSessionRuntimeStatus } from "./session-runtime-status.svelte";

export function createSessionRuntimeStore(options: SessionRuntimeStoreOptions) {
  const loading = createSessionRuntimeLoading(options);
  const config = createSessionRuntimeConfigState();
  const status = createSessionRuntimeStatus({
    client: options.client,
    isReady: loading.isReady,
  });

  function forget(sessionId: string): void {
    loading.forget(sessionId);
    config.forget(sessionId);
    status.forget(sessionId);
    if (sessionId === options.activeSessionId()) options.setActiveReady(false);
  }

  function reset(): void {
    loading.reset();
    status.reset();
    config.reset();
    options.setActiveReady(false);
  }

  return {
    get statuses() { return status.statuses; },
    get modelUsageRefreshing() { return status.modelUsageRefreshing; },
    get dcpStatsRefreshing() { return status.dcpStatsRefreshing; },
    get sessionUsageBySession() { return status.sessionUsageBySession; },
    get sessionUsageRefreshing() { return status.sessionUsageRefreshing; },
    get sessionUsageFailed() { return status.sessionUsageFailed; },
    get changingConfig() { return config.changingConfig; },
    isReady: loading.isReady,
    isLoading: loading.isLoading,
    getConfigOptions: loading.getConfigOptions,
    setConfigOptions: loading.setConfigOptions,
    ensure: loading.ensure,
    markReady: loading.markReady,
    forget,
    invalidatePrewarm: loading.invalidatePrewarm,
    schedulePrewarm: loading.schedulePrewarm,
    handleSessionState: status.handleSessionState,
    refreshStatus: status.refreshStatus,
    refreshDcpStats: status.refreshDcpStats,
    refreshSessionUsage: status.refreshSessionUsage,
    configChangeInProgress: config.configChangeInProgress,
    beginConfigChange: config.beginConfigChange,
    endConfigChange: config.endConfigChange,
    configChangeIsCurrent: config.configChangeIsCurrent,
    reset,
  };
}
