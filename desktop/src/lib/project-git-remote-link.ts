export type GitRemoteProvider = "github" | "gitlab";

export interface GitRemoteEntryLink {
  readonly provider: GitRemoteProvider;
  readonly url: string;
}

/** Published link is bound to the entry it was resolved for. */
export interface ProjectEntryRemoteLink extends GitRemoteEntryLink {
  readonly workspace: string;
  readonly path: string;
}

export function gitRemoteLinkLabel(provider: GitRemoteProvider): string {
  return provider === "gitlab" ? "Open on GitLab" : "Open on GitHub";
}

/** Owns asynchronous remote-link lookup; stale reads cannot publish into a new menu. */
export function createProjectGitRemoteLink(
  resolve: (workspace: string, path: string) => Promise<GitRemoteEntryLink | null>,
  publish: (link: ProjectEntryRemoteLink | null) => void,
) {
  let generation = 0;
  let requestedWorkspace: string | undefined;
  let requestedPath: string | undefined;

  function invalidate(): void {
    generation += 1;
  }

  async function request(workspace: string, path: string | null): Promise<void> {
    const current = ++generation;
    // Rechecking the same target keeps the visible item until fresh data arrives.
    if (workspace !== requestedWorkspace || path !== requestedPath) {
      requestedWorkspace = workspace;
      requestedPath = path ?? undefined;
      publish(null);
    }
    if (!workspace || path === null) return;
    try {
      const link = await resolve(workspace, path);
      if (current === generation) publish(link ? { ...link, workspace, path } : null);
    } catch {
      // Non-repositories, unsupported remotes and unavailable Git hide the command.
      if (current === generation) publish(null);
    }
  }

  return { request, invalidate };
}
