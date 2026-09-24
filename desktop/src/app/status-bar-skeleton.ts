export type StatusBarConnectionStatus = "starting" | "ready" | "error" | "stopped";

export function shouldShowStatusBarSkeletons(options: {
  connectionStatus: StatusBarConnectionStatus;
  draft: boolean;
  historyLoading: boolean;
  sessionId: string | null;
  runtimeReady: boolean;
  runtimeStatusAvailable: boolean;
}): boolean {
  if (options.connectionStatus === "starting") return true;
  if (options.connectionStatus !== "ready") return false;
  if (options.draft || options.historyLoading) return true;
  return options.sessionId !== null
    && (!options.runtimeReady || !options.runtimeStatusAvailable);
}
