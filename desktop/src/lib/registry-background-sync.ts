import type { RegistryProjectArtifact } from "./registry";

export type RegistryProjectSyncScope = RegistryProjectArtifact | "project";
export type RegistryBackgroundSyncPhase = "idle" | "pending" | "syncing" | "error";

export interface RegistryBackgroundSyncState {
  readonly phase: RegistryBackgroundSyncPhase;
  readonly dirtyScopes: readonly RegistryProjectArtifact[];
  readonly activeScope?: RegistryProjectSyncScope;
  readonly error?: string;
}

type RegistryBackgroundSyncOptions = {
  canSync: () => boolean;
  sync: (scope: RegistryProjectSyncScope) => Promise<void>;
  onChange: (state: RegistryBackgroundSyncState) => void;
  shouldRetryError?: (error: unknown) => boolean;
  debounceMs?: number;
  retryMs?: number;
};

const PROJECT_SCOPES: readonly RegistryProjectArtifact[] = ["tasks", "plans", "todo"];
const DEFAULT_DEBOUNCE_MS = 900;
const DEFAULT_RETRY_MS = 1_500;

/** Coalesces local project-state writes into one safe background Registry push. */
export class RegistryBackgroundSyncCoordinator {
  private readonly dirty = new Set<RegistryProjectArtifact>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private destroyed = false;
  private generation = 0;
  private phase: RegistryBackgroundSyncPhase = "idle";
  private activeScope: RegistryProjectSyncScope | undefined;
  private error: string | undefined;

  constructor(private readonly options: RegistryBackgroundSyncOptions) {
    this.publish();
  }

  get state(): RegistryBackgroundSyncState {
    return this.snapshot();
  }

  mark(scope: RegistryProjectSyncScope): void {
    if (this.destroyed) return;
    if (scope === "project") {
      for (const artifact of PROJECT_SCOPES) this.dirty.add(artifact);
    } else {
      this.dirty.add(scope);
    }
    this.error = undefined;
    if (this.phase !== "syncing") this.phase = "pending";
    this.publish();
    if (this.phase !== "syncing") this.schedule(this.options.debounceMs ?? DEFAULT_DEBOUNCE_MS, true);
  }

  retry(): void {
    if (this.destroyed || this.dirty.size === 0) return;
    this.error = undefined;
    if (this.phase !== "syncing") this.phase = "pending";
    this.publish();
    if (this.phase !== "syncing") this.schedule(0, true);
  }

  reset(): void {
    this.generation += 1;
    this.clearTimer();
    this.dirty.clear();
    this.phase = "idle";
    this.activeScope = undefined;
    this.error = undefined;
    this.publish();
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.generation += 1;
    this.clearTimer();
    this.dirty.clear();
  }

  private schedule(delayMs: number, reset: boolean): void {
    if (this.destroyed) return;
    if (reset) this.clearTimer();
    if (this.timer !== undefined) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.flush();
    }, delayMs);
  }

  private async flush(): Promise<void> {
    if (this.destroyed || this.phase === "syncing") return;
    if (this.dirty.size === 0) {
      this.phase = "idle";
      this.error = undefined;
      this.publish();
      return;
    }
    if (!this.options.canSync()) {
      this.phase = "pending";
      this.publish();
      this.schedule(this.options.retryMs ?? DEFAULT_RETRY_MS, false);
      return;
    }

    const sent = new Set(this.dirty);
    const scope = syncScope(sent);
    const generation = this.generation;
    for (const artifact of sent) this.dirty.delete(artifact);
    this.phase = "syncing";
    this.activeScope = scope;
    this.error = undefined;
    this.publish();

    try {
      await this.options.sync(scope);
    } catch (caught) {
      if (this.destroyed || generation !== this.generation) return;
      for (const artifact of sent) this.dirty.add(artifact);
      this.activeScope = undefined;
      if (this.options.shouldRetryError?.(caught)) {
        this.phase = "pending";
        this.publish();
        this.schedule(this.options.retryMs ?? DEFAULT_RETRY_MS, false);
        return;
      }
      this.phase = "error";
      this.error = caught instanceof Error ? caught.message : String(caught);
      this.publish();
      return;
    }

    if (this.destroyed || generation !== this.generation) return;

    this.activeScope = undefined;
    if (this.dirty.size > 0) {
      this.phase = "pending";
      this.publish();
      this.schedule(this.options.debounceMs ?? DEFAULT_DEBOUNCE_MS, false);
    } else {
      this.phase = "idle";
      this.publish();
    }
  }

  private clearTimer(): void {
    if (this.timer === undefined) return;
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  private snapshot(): RegistryBackgroundSyncState {
    return {
      phase: this.phase,
      dirtyScopes: PROJECT_SCOPES.filter((scope) => this.dirty.has(scope)),
      ...(this.activeScope ? { activeScope: this.activeScope } : {}),
      ...(this.error ? { error: this.error } : {}),
    };
  }

  private publish(): void {
    if (!this.destroyed) this.options.onChange(this.snapshot());
  }
}

function syncScope(dirty: ReadonlySet<RegistryProjectArtifact>): RegistryProjectSyncScope {
  if (dirty.size === 1) return dirty.values().next().value ?? "project";
  return "project";
}
