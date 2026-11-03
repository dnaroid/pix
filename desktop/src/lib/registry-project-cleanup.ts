/** A failed byte estimate must not prevent the independent native cleanup. */
export function registryProjectCleanupAllowed(state: {
  busy: boolean;
  actionId: string | null;
  loading: boolean;
  error: string | null;
  cleanupAvailable: boolean;
}): boolean {
  if (state.busy || state.actionId !== null) return false;
  if (state.error) return true;
  return !state.loading && state.cleanupAvailable;
}
