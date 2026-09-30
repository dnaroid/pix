import type { RegistryItem } from "./registry";
import type { RegistryBackgroundSyncState } from "./registry-background-sync";

/** UI policy: ordinary local writes are automatic; conflicts and errors need review. */
export function registryProjectSyncPresentation(
  items: readonly RegistryItem[],
  background: RegistryBackgroundSyncState,
  snapshotError: string | undefined,
  keyRequired: boolean,
): { title: string; description: string; needsReview: boolean } {
  const pending = items.filter((item) => item.status !== "up-to-date");
  const needsReview = background.phase === "error" || Boolean(snapshotError)
    || pending.some((item) => item.status !== "local-only" && item.status !== "local-changes");
  if (keyRequired) return { title: "Project sync needs a key", description: "Set a project key; Git is optional", needsReview: true };
  if (needsReview) return {
    title: "Review project sync",
    description: background.error ?? snapshotError ?? "Project changes need review",
    needsReview,
  };
  if (background.phase === "pending" || background.phase === "syncing" || pending.length > 0) return {
    title: "Syncing project…",
    description: "Changes sync automatically in the background",
    needsReview,
  };
  return { title: "Project synced", description: "Tasks, plans, TODO and workspace are up to date", needsReview };
}
