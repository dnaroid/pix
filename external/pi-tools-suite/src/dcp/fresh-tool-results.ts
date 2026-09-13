/**
 * Proof that a tool result was produced locally in this epoch and has never
 * belonged to an attempted provider prefix. This is NOT provider-seen evidence:
 * failed/ambiguous sends consume freshness too. Never persist or rehydrate it.
 */
export class FreshToolResultTracker {
  private ready = false;
  private readonly pending = new Map<string, string>();
  private readonly fresh = new Set<string>();

  reset(): void {
    this.ready = false;
    this.pending.clear();
    this.fresh.clear();
  }

  /** Call before every send, not after successful completion. */
  beforeProviderRequest(): void {
    this.reset();
    this.ready = true;
  }

  toolCall(id: string, name: string, alreadyKnown: boolean): void {
    // Resumed/in-flight old calls and reused IDs cannot create a freshness grant.
    if (!this.ready || alreadyKnown) return;
    this.pending.set(id, name);
  }

  toolResult(id: string, name: string): void {
    const expectedName = this.pending.get(id);
    this.pending.delete(id);
    if (expectedName === name) this.fresh.add(id);
  }

  get eligibleIds(): ReadonlySet<string> {
    return this.fresh;
  }
}
