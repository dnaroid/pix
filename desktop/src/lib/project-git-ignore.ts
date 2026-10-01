/** Owns asynchronous menu eligibility; stale reads cannot publish into a new menu. */
export function createProjectGitIgnoreEligibility(
  check: (workspace: string, path: string) => Promise<boolean>,
  publish: (allowed: boolean) => void,
) {
  let generation = 0;
  let requestedWorkspace: string | undefined;
  let requestedPath: string | undefined;

  function invalidate(): void {
    generation += 1;
  }

  async function request(workspace: string, path: string): Promise<void> {
    const current = ++generation;
    // Snapshot polling rechecks the same target: keep its confirmed visibility
    // until the fresh result arrives instead of removing/reinserting the item.
    if (workspace !== requestedWorkspace || path !== requestedPath) {
      requestedWorkspace = workspace;
      requestedPath = path;
      publish(false);
    }
    if (!workspace || !path) return;
    try {
      const allowed = await check(workspace, path);
      if (current === generation) publish(allowed);
    } catch {
      // Non-repositories and unavailable Git must not affect file browsing.
      if (current === generation) publish(false);
    }
  }

  return { request, invalidate };
}
